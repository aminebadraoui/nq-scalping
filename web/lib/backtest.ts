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

export type TuningConfig = {
  name: string;
  floor: number;
  dom: number;
  posHi: number;
  posLo: number;
  localBars: number;
  pbNear: number;
};

export const BASELINE: TuningConfig = {
  name: "baseline",
  floor: 20,
  dom: 0.6,
  posHi: 0.7,
  posLo: 0.3,
  localBars: 60,
  pbNear: 3,
};

/** round-trip cost in NQ points: ~0.25 pt slippage + ~0.25 pt commission */
const COST_PTS = 0.5;
/** max holding bars before a time-based exit */
const HOLD_BARS = 60;

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
  exit: number;
  pnl: number; // net points (cost already deducted)
  hit: "target" | "stop" | "time";
  heldBars: number;
};

function scoreFire(minutes: FootprintMinute[], fire: Fire): TradeResult | null {
  const { entry, stop, target, side } = fire;
  const dir = side === "long" ? 1 : -1;
  // invalid levels (wrong side / NaN) can't be evaluated — drop
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) return null;
  if (side === "long" && !(stop < entry && entry < target)) return null;
  if (side === "short" && !(target < entry && entry < stop)) return null;

  const start = fire.bar + 1;
  const end = Math.min(minutes.length - 1, fire.bar + HOLD_BARS);
  let hit: TradeResult["hit"] = "time";
  let exit = minutes[end]?.c > 0 ? minutes[end].c : minutes[end]?.high ?? entry;
  let heldBars = end - fire.bar;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const low = b.low;
    const high = b.high;
    if (side === "long") {
      if (low <= stop && high >= target) { hit = "stop"; exit = stop; heldBars = j - fire.bar; break; } // conservative: stop first
      if (low <= stop) { hit = "stop"; exit = stop; heldBars = j - fire.bar; break; }
      if (high >= target) { hit = "target"; exit = target; heldBars = j - fire.bar; break; }
    } else {
      if (high >= stop && low <= target) { hit = "stop"; exit = stop; heldBars = j - fire.bar; break; }
      if (high >= stop) { hit = "stop"; exit = stop; heldBars = j - fire.bar; break; }
      if (low <= target) { hit = "target"; exit = target; heldBars = j - fire.bar; break; }
    }
  }

  const pnl = (exit - entry) * dir - COST_PTS;
  return { ...fire, exit, pnl, hit, heldBars };
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
  return { date, minutes, mapped, mIndex, candles, lvnEdges, pocCands, prefixHigh, prefixLow, prefixVwap, alerts: an.alerts, reclaims: an.reclaims, imbalance: an.imbalance };
}

/** replay one session under one config (cheap; reuses SessionData). */
export function replay(sd: SessionData, cfg: TuningConfig): SessionResult {
  const { minutes, mapped, mIndex, candles, prefixHigh, prefixLow, prefixVwap, lvnEdges, pocCands, alerts, reclaims, imbalance } = sd;
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

    // production fire rule: reversal only, full sequence (present >= 5) AND
    // price action aligned on the same side
    if ((mech.tone === "long" || mech.tone === "short") && mech.present >= 5 && pa.side === mech.side) {
      fires.push({ bar: i, t: cdtToET(minutes[i].t), setup: "reversal", side: mech.side!, entry: mech.entryPx, stop: mech.stopPx, target: mech.targetPx });
    }
  }

  const trades = fires.map((f) => scoreFire(minutes, f)).filter((x): x is TradeResult => x !== null);
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
};

function summarize(trades: TradeResult[]): SetupStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPts = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPts,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgPts: trades.length ? netPts / trades.length : 0,
  };
}

export async function runSweep(
  configs: TuningConfig[],
  opts?: { session?: "RTH" | "ETH"; maxSessions?: number; splitDate?: string },
): Promise<ConfigResult[]> {
  const datasets = await listDatasets();
  const dates = datasets.filter((d) => d.sessions.includes(opts?.session ?? "RTH")).map((d) => d.date);
  const use = opts?.maxSessions ? dates.slice(0, opts.maxSessions) : dates;
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
      for (const t of r.trades) a.perSetup[t.setup].push(t);
    }
  }

  return agg.map((a) => ({
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
  }));
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
    { ...base, name: "floor=0", floor: 0 },
    { ...base, name: "floor=10", floor: 10 },
    { ...base, name: "floor=30", floor: 30 },
    { ...base, name: "floor=40", floor: 40 },
    { ...base, name: "dom=0.5", dom: 0.5 },
    { ...base, name: "dom=0.55", dom: 0.55 },
    { ...base, name: "pos=relaxed", posHi: 0.85, posLo: 0.15 },
    { ...base, name: "pos=off", posHi: 1.0, posLo: 0.0 },
    { ...base, name: "pbNear=6", pbNear: 6 },
    { ...base, name: "pbNear=10", pbNear: 10 },
    { ...base, name: "floor=10+dom=0.55", floor: 10, dom: 0.55 },
    { ...base, name: "floor=10+pbNear=6", floor: 10, pbNear: 6 },
    { ...base, name: "dom=0.55+pbNear=10", dom: 0.55, pbNear: 10 },
    { ...base, name: "floor=10+dom=0.55+pbNear=6", floor: 10, dom: 0.55, pbNear: 6 },
  ];
}
