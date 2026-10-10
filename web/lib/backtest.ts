/* ------------------------------------------------------------------ *
 * Offline backtest harness for the signal thresholds.
 *
 * Replays the reversal + pullback signal bar-by-bar over the collected
 * sessions and scores each fire forward (entry → target or stop, with a
 * round-trip cost). The knobs swept here are the signal thresholds only —
 * the tunables that decide WHEN a signal fires:
 *
 *   floor    absorption absolute volume floor (contracts)
 *   dom      absorption one-sidedness threshold (0..1)
 *   posHi    ask-dominant absorption must sit above this fraction of the
 *            local range (near-top)
 *   posLo    bid-dominant absorption must sit below this fraction (near-bottom)
 *   localBars  trailing bars for the "near extreme" window (0 = full session)
 *   pbNear   pullback retest tolerance (points)
 *
 * The location profile (LVN edges + POC) is the session's own aggregate —
 * the "P0 Live" profile — consistent across every config so the RELATIVE
 * comparison between configs is fair. That profile is the full-day one, so
 * absolute P&L is optimistic (it sees levels formed later in the day); the
 * RANKING across configs is what this harness is for.
 * ------------------------------------------------------------------ */

import { aggregate, stats, listDatasets, extractFootprint, analyze, computeSheet, type FootprintMinute, type AbsorbEvent, type AlertEvent, type Reclaim, type ImbalanceRollup, type LevelSheet, type Candle } from "./gcdata";
import { readMechanism } from "./mechanism";
import { readPriceAction } from "./priceaction";
import { cdtToET } from "./times";
import { dollarize, simulateAccount, type AccountSimResult } from "./propAccount";
import { loadSessionDivergences, type DivRow } from "./divStore";
import { divergenceFuel } from "./divergence";
// consolidated engine: the one scorer + the standard T1 metric set
import { scoreTrade, coreStats, propViability, type CoreStats, type Viability } from "./backtestEngine";

export type TuningConfig = {
  name: string;
  floor: number;
  dom: number;
  posHi: number;
  posLo: number;
  localBars: number;
  presentMin: number;
};

export const BASELINE: TuningConfig = {
  name: "baseline",
  floor: 20,
  dom: 0.6,
  posHi: 0.7,
  posLo: 0.3,
  localBars: 60,
  presentMin: 5,
};

/** round-trip cost in NQ points: ~0.25 pt slippage + ~0.25 pt commission */
const COST_PTS = 0.5;
/** max holding bars before a time-based exit */
const HOLD_BARS = 60;
/** divergence "fuel" window — a matching D2/D4 within this many bars BEFORE
 *  the entry counts (the same DIV_BARS the studies use, shared definition) */
const DIV_BARS = 10;

/* ---------------- tunable absorption (mirrors gcdata.ts analyzeMinutes) ---------------- */

export function detectAbsorption(minutes: FootprintMinute[], cfg: TuningConfig): AbsorbEvent[] {
  const levelVols: number[] = [];
  for (const m of minutes) for (const l of m.levels) levelVols.push(l.buy + l.sell);
  levelVols.sort((a, b) => a - b);
  const med = levelVols[levelVols.length >> 1] ?? 0;
  const volFloor = Math.max(cfg.floor, med * 1.5);

  const fullLow = minutes.length ? Math.min(...minutes.map((m) => m.low)) : 0;
  const fullHigh = minutes.length ? Math.max(...minutes.map((m) => m.high)) : 0;

  const out: AbsorbEvent[] = [];
  const seen = new Set<string>();

  minutes.forEach((m, mi) => {
    let localLow = fullLow;
    let localHigh = fullHigh;
    if (cfg.localBars > 0) {
      localLow = Infinity;
      localHigh = -Infinity;
      const from = Math.max(0, mi - cfg.localBars);
      for (let k = from; k <= mi; k++) {
        if (minutes[k].low < localLow) localLow = minutes[k].low;
        if (minutes[k].high > localHigh) localHigh = minutes[k].high;
      }
    }
    const localRange = localHigh - localLow;

    for (const l of m.levels) {
      const total = l.buy + l.sell;
      if (total < volFloor) continue;
      const dom = Math.abs(l.buy - l.sell) / total;
      if (dom < cfg.dom) continue;
      const askSide = l.buy > l.sell;
      const pos = localRange > 0.25 ? (l.price - localLow) / localRange : 0.5;
      if (askSide && pos < cfg.posHi) continue;
      if (!askSide && pos > cfg.posLo) continue;

      let broke = false;
      for (let j = mi + 1; j < Math.min(minutes.length, mi + 4); j++) {
        if (askSide && minutes[j].high >= l.price + 0.5) { broke = true; break; }
        if (!askSide && minutes[j].low <= l.price - 0.5) { broke = true; break; }
      }
      if (broke) continue;
      const key = `${l.price}|${askSide ? "a" : "b"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        t: m.t,
        price: l.price,
        side: askSide ? "ask" : "bid",
        bias: askSide ? "bear" : "bull",
        volume: total,
        imbalance: dom,
        defendedBars: Math.min(3, minutes.length - mi - 1),
      });
    }
  });
  out.sort((a, b) => (a.t < b.t ? -1 : 1));
  return out;
}

/* ---------------- forward trade scoring ---------------- */

export type Fire = {
  bar: number;
  t: string;
  setup: "reversal" | "pullback";
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
};

export type TradeResult = Fire & {
  date: string; // session date the trade was replayed in
  exit: number;
  pnl: number; // net points (cost already deducted)
  hit: "target" | "stop" | "time";
  heldBars: number;
  /** a matching divergence (D2 for longs / D4 for shorts) sat within the
   *  fuel window before this entry — the win-rate influence question */
  hasDiv: boolean;
};

/** the canonical forward scorer from the consolidated engine, wired to this
 *  harness's conventions: 0.5 pt cost, 60-bar time exit, close = c>0 ? c :
 *  high (the historical time-exit rule), pessimistic stop-first. */
function scoreFire(minutes: FootprintMinute[], fire: Fire, hasDiv: boolean): TradeResult | null {
  const dir = fire.side === "long" ? 1 : -1;
  const risk = Math.abs(fire.entry - fire.stop);
  const sc = scoreTrade(
    minutes,
    { dir, entry: fire.entry, stop: fire.stop, target: fire.target, entryIdx: fire.bar, risk },
    { costPts: COST_PTS, holdBars: HOLD_BARS, timeClose: (b) => (b.c > 0 ? b.c : b.high), onNoBars: "time" },
  );
  if (!sc) return null;
  return { ...fire, date: "", exit: sc.exit, pnl: sc.pnl, hit: sc.hit, heldBars: sc.heldBars, hasDiv };
}

/* ---------------- session replay ---------------- */

export type SessionResult = {
  date: string;
  fires: Fire[];
  trades: TradeResult[];
};

/** config-independent inputs for one session, loaded once and reused across configs */
export type SessionData = {
  date: string;
  minutes: FootprintMinute[];
  mapped: { t: string; high: number; low: number; delta: number }[];
  mIndex: Map<string, number>;
  /** aggregate-format candles (cents) — reused for the rolling developing profile */
  candles: Candle[];
  /** STATIC location from the PRIOR day's level sheet (no lookahead) */
  lvnEdges: { label: string; p: number; zone: string }[];
  pocCands: { label: string; p: number }[];
  prefixHigh: number[];
  prefixLow: number[];
  prefixVwap: number[];
  alerts: AlertEvent[];
  reclaims: Reclaim[];
  imbalance: ImbalanceRollup | null;
  /** stored per-session divergences (canonical divStore artifact) */
  divergences: DivRow[];
};

/** extract LVN edges + POCs from a level sheet (cents strings → points) */
function sheetLevels(sheet: LevelSheet): { lvnEdges: { label: string; p: number; zone: string }[]; pocCands: { label: string; p: number }[] } {
  const lvnEdges: { label: string; p: number; zone: string }[] = [];
  const pocCands: { label: string; p: number }[] = [];
  for (const [key, v] of Object.entries(sheet.profiles)) {
    if (!v) continue;
    for (const z of v.LVNs ?? []) {
      const [a, b] = z.split("–").map((s) => parseFloat(s.replace(/,/g, "")));
      if (!Number.isFinite(a)) continue;
      lvnEdges.push({ label: key, p: a, zone: z });
      if (Number.isFinite(b)) lvnEdges.push({ label: key, p: b, zone: z });
    }
    const poc = parseFloat(v.POC.replace(/,/g, ""));
    if (Number.isFinite(poc)) pocCands.push({ label: `${key} POC`, p: poc });
  }
  return { lvnEdges, pocCands };
}

export async function loadSession(date: string, session: "RTH" | "ETH", priorDate: string | null): Promise<SessionData | null> {
  const fp = await extractFootprint(date, session);
  const an = await analyze(date, session);
  if (!fp || !an || fp.minutes.length < 5) return null;
  const minutes = fp.minutes;
  const n = minutes.length;

  // STATIC location: the PRIOR day's level sheet (what production's `ctx.levels`
  // holds) — no lookahead into the session being backtested.
  let lvnEdges: { label: string; p: number; zone: string }[] = [];
  let pocCands: { label: string; p: number }[] = [];
  if (priorDate) {
    try {
      const sheet = await computeSheet(priorDate);
      ({ lvnEdges, pocCands } = sheetLevels(sheet));
    } catch {
      /* no prior sheet — location degrades to the rolling profile only */
    }
  }

  // aggregate-format candles (cents) for the rolling developing profile
  const candles: Candle[] = minutes.map((m) => ({
    t: `${m.d}T${m.t}:00-05:00`,
    high: Math.round(m.high * 100),
    low: Math.round(m.low * 100),
    total: m.buy + m.sell,
    buy: m.buy,
    sell: m.sell,
    levels: Object.fromEntries(m.levels.map((l) => [String(Math.round(l.price * 100)), [l.buy + l.sell, l.buy, l.sell, l.bTrades, l.sTrades] as [number, number, number, number, number]])),
  }));

  // prefix session high/low + VWAP (no lookahead)
  const prefixHigh: number[] = new Array(n);
  const prefixLow: number[] = new Array(n);
  const prefixVwap: number[] = new Array(n);
  let vnum = 0;
  let vden = 0;
  for (let i = 0; i < n; i++) {
    const m = minutes[i];
    prefixHigh[i] = i === 0 ? m.high : Math.max(prefixHigh[i - 1], m.high);
    prefixLow[i] = i === 0 ? m.low : Math.min(prefixLow[i - 1], m.low);
    const v = m.buy + m.sell;
    const px = m.c > 0 ? (m.high + m.low + m.c) / 3 : (m.high + m.low) / 2;
    if (v > 0) { vnum += px * v; vden += v; }
    prefixVwap[i] = vden > 0 ? vnum / vden : 0;
  }

  const mapped = minutes.map((m) => ({ t: m.t, high: m.high, low: m.low, delta: m.buy - m.sell }));
  const mIndex = new Map(mapped.map((m, i) => [m.t, i] as const));

  // the divergence store (loads the canonical artifact; a read miss computes
  // and persists it, so this backtest itself progressively fills the store)
  const divStore = await loadSessionDivergences(date, session);

  return {
    date,
    minutes,
    mapped,
    mIndex,
    candles,
    lvnEdges,
    pocCands,
    prefixHigh,
    prefixLow,
    prefixVwap,
    alerts: an.alerts,
    reclaims: an.reclaims,
    imbalance: an.imbalance,
    divergences: divStore?.divergences ?? [],
  };
}

/** replay one session under one config (cheap; reuses SessionData). */
export function replay(sd: SessionData, cfg: TuningConfig): SessionResult {
  const { minutes, mapped, mIndex, candles, prefixHigh, prefixLow, prefixVwap, lvnEdges, pocCands, alerts, reclaims, imbalance, divergences } = sd;
  const n = minutes.length;
  const absorption = detectAbsorption(minutes, cfg);
  const fires: Fire[] = [];

  // incremental developing profile: running 1-pt bucket map (cents) so each
  // bar's P0/LVN read only sees bars seen SO FAR — no lookahead
  const runningRows = new Map<number, { buy: number; sell: number }>();

  for (let i = 5; i < n; i++) {
    const lastPrice = minutes[i].c > 0 ? minutes[i].c : minutes[i].high;
    const window = mapped.slice(0, i + 1);

    for (const [lvl, [, bv, sv]] of Object.entries(candles[i].levels)) {
      const bucket = Math.round(Number(lvl) / 100) * 100;
      const r = runningRows.get(bucket) ?? { buy: 0, sell: 0 };
      r.buy += bv;
      r.sell += sv;
      runningRows.set(bucket, r);
    }
    const liveStats = stats(runningRows);
    const allEdges = [...lvnEdges];
    const allPocs = [...pocCands];
    if (liveStats) {
      for (const [a, b] of liveStats.lvns) {
        allEdges.push({ label: "P0 Live", p: a / 100, zone: `${a / 100}–${b / 100}` });
        allEdges.push({ label: "P0 Live", p: b / 100, zone: `${a / 100}–${b / 100}` });
      }
      if (liveStats.poc > 0) allPocs.unshift({ label: "P0 Live POC", p: liveStats.poc / 100 });
    }
    const nearestPoc = allPocs.length
      ? [...allPocs].sort((a, b) => Math.abs(a.p - lastPrice) - Math.abs(b.p - lastPrice))[0]
      : null;

    const mech = readMechanism({
      minutes: window,
      lastPrice,
      vwap: prefixVwap[i],
      absorption,
      alerts,
      reclaims,
      imbalance,
      lvnEdges: allEdges,
      poc: nearestPoc,
      sessionHigh: prefixHigh[i],
      sessionLow: prefixLow[i],
      newsWin: false,
    }, mIndex);
    const pa = readPriceAction({
      minutes: window.map((m) => ({ high: m.high, low: m.low, t: m.t })),
      lastPrice,
      sessionHigh: prefixHigh[i],
      sessionLow: prefixLow[i],
    });

    // production fire rule: reversal only, full sequence (present >= presentMin)
    // AND price action aligned on the same side
    if ((mech.tone === "long" || mech.tone === "short") && mech.present >= cfg.presentMin && pa.side === mech.side) {
      fires.push({ bar: i, t: cdtToET(minutes[i].t), setup: "reversal", side: mech.side!, entry: mech.entryPx, stop: mech.stopPx, target: mech.targetPx });
    }
  }

  // tag each fire with its divergence fuel (shared rule) so the sweep can
  // report the win-rate influence of a matching D2/D4
  const trades = fires
    .map((f) => scoreFire(minutes, f, divergenceFuel(divergences, f.t, f.side, DIV_BARS) !== null))
    .filter((x): x is TradeResult => x !== null)
    .map((t) => ({ ...t, date: sd.date }));
  return { date: sd.date, fires, trades };
}

/* ---------------- sweep ---------------- */

export type SetupStats = {
  trades: number;
  wins: number;
  winRate: number;
  netPts: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  avgPts: number;
  /** the fuel split — does a matching divergence change the win rate? */
  withDiv: FuelSplit;
  withoutDiv: FuelSplit;
  /** standard T1 columns (consolidated engine — BACKTEST-REPORT-STANDARD.md) */
  avgWin: number;
  avgLoss: number;
  payoff: number;
  expR: number;
  sqn: number;
  maxDdPts: number;
  sharpeSess: number;
  concTop10: number;
  wrCiLo: number;
  wrCiHi: number;
};

/** win/loss aggregates of one trade cohort (divergence-fueled vs not) */
export type FuelSplit = {
  trades: number;
  wins: number;
  winRate: number;
  netPts: number;
  profitFactor: number;
};

/** the rules layer every sweep run now reports: every trade sized under the
 *  Rapid EOD 50k plan ($170 budget, 30-micro cap, $2/pt) and replayed through
 *  the account (EOD trailing MLL, $100 lock, target/consistency/payouts). */
export type AccountSummary = {
  dollarNet: number;
  dollarAvg: number;
  eval: AccountSimResult;
  funded: AccountSimResult;
  /** T4 — pass-before-breach bootstrap + maxDD vs MLL (consolidated engine) */
  viability: Viability;
};

export type ConfigResult = {
  config: TuningConfig;
  sessions: number;
  trainSessions: number;
  testSessions: number;
  all: SetupStats;
  train: SetupStats;
  test: SetupStats;
  bySetup: { reversal: SetupStats; pullback: SetupStats };
  byYear: { year: string; stats: SetupStats }[];
  account: AccountSummary;
};

function fuel(trades: TradeResult[]): FuelSplit {
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPts: trades.reduce((a, t) => a + t.pnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
  };
}

function summarize(trades: TradeResult[]): SetupStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPts = trades.reduce((a, t) => a + t.pnl, 0);
  // the standard T1 set from the consolidated engine
  const std: CoreStats = coreStats(trades.map((t) => ({ date: t.date, pnl: t.pnl, risk: Math.abs(t.entry - t.stop) })));
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPts,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgPts: trades.length ? netPts / trades.length : 0,
    withDiv: fuel(trades.filter((t) => t.hasDiv)),
    withoutDiv: fuel(trades.filter((t) => !t.hasDiv)),
    avgWin: std.avgWin,
    avgLoss: std.avgLoss,
    payoff: std.payoff,
    expR: std.expR,
    sqn: std.sqn,
    maxDdPts: std.maxDdPts,
    sharpeSess: std.sharpeSess,
    concTop10: std.concTop10,
    wrCiLo: std.wrCi[0],
    wrCiHi: std.wrCi[1],
  };
}

export async function runSweep(
  configs: TuningConfig[],
  opts?: { session?: "RTH" | "ETH"; maxSessions?: number; splitDate?: string },
): Promise<ConfigResult[]> {
  const datasets = await listDatasets();
  const dates = datasets.filter((d) => d.sessions.includes(opts?.session ?? "RTH")).map((d) => d.date);
  const use = (opts?.maxSessions ? dates.slice(0, opts.maxSessions) : dates).sort();
  const splitDate = opts?.splitDate ?? "2026-01-01";

  // date → prior trading day, so each session's location uses the PRIOR day's
  // level sheet (no lookahead into the session itself)
  const sorted = [...dates].sort();
  const priorMap = new Map<string, string>();
  for (let i = 1; i < sorted.length; i++) priorMap.set(sorted[i], sorted[i - 1]);

  const agg = configs.map((config) => ({
    config,
    sessions: 0,
    trainSessions: 0,
    testSessions: 0,
    all: [] as TradeResult[],
    train: [] as TradeResult[],
    test: [] as TradeResult[],
    perSetup: { reversal: [] as TradeResult[], pullback: [] as TradeResult[] },
    byYear: {} as Record<string, TradeResult[]>,
    /** dated point P&L + risk for the rules layer (dollarize → simulateAccount) */
    acct: [] as { date: string; pnlPts: number; riskPts: number }[],
  }));

  for (const date of use) {
    const sd = await loadSession(date, opts?.session ?? "RTH", priorMap.get(date) ?? null);
    if (!sd) continue;
    const isTrain = date < splitDate;
    const year = date.slice(0, 4);
    for (const a of agg) {
      const r = replay(sd, a.config);
      a.sessions++;
      if (isTrain) a.trainSessions++;
      else a.testSessions++;
      a.all.push(...r.trades);
      (isTrain ? a.train : a.test).push(...r.trades);
      (a.byYear[year] ??= []).push(...r.trades);
      for (const t of r.trades) {
        a.perSetup[t.setup].push(t);
        a.acct.push({ date, pnlPts: t.pnl, riskPts: Math.abs(t.entry - t.stop) });
      }
    }
  }

  return agg.map((a) => {
    const dollars = dollarize(a.acct);
    return {
      config: a.config,
      sessions: a.sessions,
      trainSessions: a.trainSessions,
      testSessions: a.testSessions,
      all: summarize(a.all),
      train: summarize(a.train),
      test: summarize(a.test),
      bySetup: { reversal: summarize(a.perSetup.reversal), pullback: summarize(a.perSetup.pullback) },
      byYear: Object.entries(a.byYear)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([year, trades]) => ({ year, stats: summarize(trades) })),
      account: {
        dollarNet: Math.round(dollars.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
        dollarAvg: dollars.length
          ? Math.round((dollars.reduce((s, t) => s + t.pnl, 0) / dollars.length) * 100) / 100
          : 0,
        eval: simulateAccount(dollars, "eval"),
        funded: simulateAccount(dollars, "funded"),
        // T4: pass-before-breach over day order + maxDD vs MLL
        viability: propViability(a.acct.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }))),
      },
    };
  });
}

/** pick the best config on TRAIN only, and return its out-of-sample (test) stats */
export function walkForwardBest(results: ConfigResult[]): { trainBest: ConfigResult; testOfBest: SetupStats } | null {
  if (!results.length) return null;
  const trainBest = [...results].sort((a, b) => b.train.netPts - a.train.netPts)[0];
  return { trainBest, testOfBest: trainBest.test };
}

/** convenience: the current defaults + a focused one-axis sweep around them */
export function sweepConfigs(): TuningConfig[] {
  const base = { ...BASELINE };
  return [
    base,
    { ...base, name: "presentMin=3", presentMin: 3 },
    { ...base, name: "presentMin=4", presentMin: 4 },
    { ...base, name: "presentMin=6", presentMin: 6 },
    { ...base, name: "floor=10", floor: 10 },
    { ...base, name: "floor=30", floor: 30 },
    { ...base, name: "dom=0.55", dom: 0.55 },
    { ...base, name: "pos=relaxed", posHi: 0.85, posLo: 0.15 },
    { ...base, name: "presentMin=4+dom=0.55", presentMin: 4, dom: 0.55 },
    { ...base, name: "presentMin=6+floor=30", presentMin: 6, floor: 30 },
    { ...base, name: "presentMin=4+floor=10", presentMin: 4, floor: 10 },
    { ...base, name: "presentMin=5+dom=0.55+floor=10", presentMin: 5, dom: 0.55, floor: 10 },
  ];
}
