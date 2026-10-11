/* ------------------------------------------------------------------ *
 * Consolidated backtest engine — the single home for:
 *
 *   1. Replay scoring  — one canonical forward scorer (pessimistic
 *      same-bar rule: stop first when stop and target sit in one bar),
 *      0.5 pt round-trip cost, 60-bar time exit. Formerly duplicated as
 *      scoreFire (lib/backtest.ts), scoreSignal (scripts/momentumStudy.ts)
 *      and scoreSignal (scripts/exportSweep.ts).
 *   2. The standard metric set — every column of the T1 core quality
 *      table and T2 segment rows from docs/BACKTEST-REPORT-STANDARD.md.
 *   3. Prop viability — T4: the account sim rows plus the
 *      pass-before-breach bootstrap over day order.
 *   4. The standard markdown renderers — T0/T1/T2/T4 + the five-slot
 *      VERDICT line, byte-for-byte the columns of the standard.
 *
 * Pure functions only (no fs, no network) — unit-tested in
 * tests/backtestEngine.test.ts. Every backtest harness and study script
 * imports from here instead of computing its own stats.
 * ------------------------------------------------------------------ */

import { dollarize, simulateAccount, accountLine, type AccountSimResult } from "./propAccount";
import { RAPID_EOD_50K, type PropRules } from "./propRules";

/* ================= 1. canonical trade shape ================= */

export type EngineTrade = {
  date: string; // session date YYYY-MM-DD (the only ordering key)
  pnl: number; // net points, costs included
  risk: number; // stop distance in points (the R denominator); > 0
};

/* ================= 1. replay scoring ================= */

export type ScoreBar = { high: number; low: number; c: number };

export type ScoreSpec = {
  dir: 1 | -1;
  entry: number;
  stop: number;
  target: number;
  entryIdx: number; // bar whose close is the entry; scoring starts at +1
  risk: number;
};

export type ScoreOpts = {
  costPts?: number;
  holdBars?: number;
  /** time-exit close rule; default = midpoint fallback (momentum closeOf) */
  timeClose?: (b: ScoreBar) => number;
  /** no forward bars to evaluate (fire on the session's last bar):
   *  "drop" (default, momentumStudy convention) or "time" (lib/backtest's
   *  historical convention: a −cost time exit at entry) */
  onNoBars?: "drop" | "time";
};

export const DEFAULT_COST = 0.5;
export const DEFAULT_HOLD = 60;

export type ScoredOutcome = {
  exit: number;
  pnl: number; // net points after cost
  hit: "target" | "stop" | "time";
  heldBars: number;
  risk: number;
  mfeR: number;
  maeR: number;
  runPts: number;
  hit2R: boolean;
  hit3R: boolean;
  ambiguous: boolean; // stop AND target both inside the first bar after entry
};

const defaultClose = (b: ScoreBar): number => (b.c > 0 ? b.c : (b.high + b.low) / 2);

/** The one canonical forward scorer. Pessimistic: when a single bar
 *  contains both the stop and the target, the stop wins (counted as a
 *  loss). Mirrors the live trader's worst case, and matches the semantics
 *  of the three former scoring implementations exactly. */
export function scoreTrade(minutes: ScoreBar[], spec: ScoreSpec, opts?: ScoreOpts): ScoredOutcome | null {
  const { dir, entry, stop, target, entryIdx, risk } = spec;
  if (!(risk > 0)) return null;
  if (dir > 0 && !(stop < entry && entry < target)) return null;
  if (dir < 0 && !(target < entry && entry < stop)) return null;
  const costPts = opts?.costPts ?? DEFAULT_COST;
  const holdBars = opts?.holdBars ?? DEFAULT_HOLD;
  const tclose = opts?.timeClose ?? defaultClose;

  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + holdBars);
  if (start > end) {
    if (opts?.onNoBars !== "time") return null;
    return { exit: entry, pnl: -costPts, hit: "time", heldBars: 0, risk, mfeR: 0, maeR: 0, runPts: 0, hit2R: false, hit3R: false, ambiguous: false };
  }

  let hit: ScoredOutcome["hit"] = "time";
  let exit = tclose(minutes[end]);
  let heldBars = end - entryIdx;
  let mfe = 0;
  let mae = 0;
  let run = 0;
  let ambiguous = false;
  let hit2R = false;
  let hit3R = false;
  const t2 = dir > 0 ? entry + 2 * risk : entry - 2 * risk;
  const t3 = dir > 0 ? entry + 3 * risk : entry - 3 * risk;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    run = Math.max(run, fav);
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (j === start && stopHit && tgtHit) ambiguous = true;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - entryIdx;
      break;
    }
    if (dir > 0 ? b.high >= t3 : b.low <= t3) hit3R = true;
    if (dir > 0 ? b.high >= t2 : b.low <= t2) hit2R = true;
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - entryIdx;
      break;
    }
  }

  const pnl = (exit - entry) * dir - costPts;
  return { exit, pnl, hit, heldBars, risk, mfeR: mfe, maeR: mae, runPts: run, hit2R, hit3R, ambiguous };
}

/** One-trade-at-a-time overlay: a signal whose entry bar falls inside an
 *  open trade is skipped (the live trader cannot be in two trades).
 *  `occupy` = "held" closes the window at the actual exit bar
 *  (momentumStudy semantics); "full" holds the whole window regardless of
 *  exit (exportSweep's historical, more conservative semantics — kept so
 *  the Python validator's input does not change; pass `window` = its
 *  time-exit length). */
export function scoreSequential<T extends { entryIdx: number }, O extends { heldBars?: number }>(
  signals: T[],
  score: (s: T) => O | null,
  opts?: { occupy?: "held" | "full"; window?: number },
): O[] {
  const occupy = opts?.occupy ?? "held";
  const out: O[] = [];
  let openUntil = -1;
  for (const s of signals) {
    if (s.entryIdx <= openUntil) continue;
    const sc = score(s);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.entryIdx + (occupy === "full" ? (opts?.window ?? sc.heldBars ?? 0) : sc.heldBars ?? 0);
  }
  return out;
}

/* ================= 2. standard metrics (T1 / T2) ================= */

/** Wilson 95% confidence interval for a proportion, in percent. */
export function wilson95(wins: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, ((c - s) / d) * 100), Math.min(100, ((c + s) / d) * 100)];
}

export type CoreStats = {
  n: number;
  wins: number;
  losses: number;
  wr: number; // percent
  wrCi: [number, number]; // Wilson 95, percent
  avgWin: number; // pts, mean of winners
  avgLoss: number; // pts, mean |pnl| of losers (positive magnitude)
  payoff: number; // avgWin / avgLoss (Infinity when no losses)
  expPts: number; // net pts per trade
  expR: number; // mean pnl/risk
  pf: number; // gross win / gross loss (Infinity when no losses)
  sqn: number; // (mean R / sd R) × sqrt(n)
  maxDdPts: number; // deepest peak-to-trough on the 1-contract equity curve (positive magnitude)
  sharpeSess: number; // per-session return-on-risk (netPts/riskPts), mean/sd
  concTop10: number; // % of total net from the top-10 sessions
  netPts: number;
  grossWin: number;
  grossLoss: number;
  sessions: number;
};

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
};

/** The full T1 row for one cohort. `sessionUniverse` pads per-session
 *  Sharpe with 0-return sessions (the validation-pipeline convention for
 *  "the config did not trade"). Trades are consumed in date order. */
export function coreStats(trades: EngineTrade[], opts?: { sessionUniverse?: string[] }): CoreStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? gw / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 0;

  // 1-contract equity curve → max drawdown (positive magnitude)
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // per-session return-on-risk (the validation-pipeline unit)
  const byDate = new Map<string, { pnl: number; risk: number }>();
  for (const t of trades) {
    const e = byDate.get(t.date) ?? { pnl: 0, risk: 0 };
    e.pnl += t.pnl;
    e.risk += t.risk;
    byDate.set(t.date, e);
  }
  const universe = opts?.sessionUniverse?.length ? opts.sessionUniverse : [...byDate.keys()].sort();
  const rors = universe.map((d) => {
    const e = byDate.get(d);
    return e && e.risk > 0 ? e.pnl / e.risk : 0;
  });
  const sharpeSess = sd(rors) > 0 ? mean(rors) / sd(rors) : mean(rors) > 0 ? Infinity : 0;

  // concentration: share of net from the top-10 sessions
  const perSession = [...byDate.values()].map((e) => e.pnl).sort((a, b) => b - a);
  const top10 = perSession.slice(0, 10).reduce((a, v) => a + v, 0);
  const concTop10 = net > 0 ? (top10 / net) * 100 : 0;

  // SQN on per-trade R multiples
  const rs = trades.map((t) => (t.risk > 0 ? t.pnl / t.risk : 0));
  const sqn = sd(rs) > 0 ? (mean(rs) / sd(rs)) * Math.sqrt(n) : mean(rs) > 0 ? Infinity : 0;

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    wr: n ? (wins.length / n) * 100 : 0,
    wrCi: wilson95(wins.length, n),
    avgWin,
    avgLoss,
    payoff: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    expPts: n ? net / n : 0,
    expR: n ? mean(rs) : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    sqn,
    maxDdPts: maxDd,
    sharpeSess,
    concTop10,
    netPts: net,
    grossWin: gw,
    grossLoss: gl,
    sessions: byDate.size,
  };
}

export function byYear(trades: EngineTrade[]): { year: string; stats: CoreStats }[] {
  const m = new Map<string, EngineTrade[]>();
  for (const t of trades) {
    const y = t.date.slice(0, 4);
    const list = m.get(y);
    if (list) list.push(t);
    else m.set(y, [t]);
  }
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, list]) => ({ year, stats: coreStats(list) }));
}

/** early/late halves of the time-ordered trades — the stability check. */
export function earlyLate(trades: EngineTrade[]): { early: CoreStats; late: CoreStats } {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const half = Math.floor(sorted.length / 2);
  return { early: coreStats(sorted.slice(0, half)), late: coreStats(sorted.slice(half)) };
}

/* ================= 3. prop viability (T4) ================= */

export type Viability = {
  evalSim: AccountSimResult;
  fundedSim: AccountSimResult;
  evalTest: AccountSimResult | null; // split-restricted sim (null when no splitDate)
  fundedTest: AccountSimResult | null;
  maxDdUsd: number; // deepest drawdown on the dollarized equity curve
  mllRatio: number; // maxDdUsd ÷ rules.maxLoss
  /** bootstrap over day-order reshuffles: share of eval replays that pass
   *  before breaching, and the median trading days to pass among them */
  pPass: number | null;
  medianDaysToPass: number | null;
  iters: number;
};

/** seeded deterministic RNG (mulberry32) — same family as the lab bootstrap */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * T4 — the prop-firm viability layer. Replays the dollarized trades
 * through the account rules (eval + funded), then answers the deployment
 * question "does the account reach the profit target before the
 * trailing floor is breached?" empirically: P(pass before breach) is the
 * share of day-order reshuffles (bootstrap) that pass. Shuffling is
 * defensible because per-session returns have ~0 autocorrelation
 * (validation pipeline) — callers should note when it isn't.
 */
export function propViability(
  trades: EngineTrade[],
  opts?: {
    splitDate?: string;
    rules?: PropRules;
    iters?: number;
    seed?: number;
    budget?: number;
    pointValue?: number;
  },
): Viability {
  const rules = opts?.rules ?? RAPID_EOD_50K;
  const iters = opts?.iters ?? 500;
  const seed = opts?.seed ?? 0x5eed;
  const splitDate = opts?.splitDate;
  const d = dollarize(
    trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })),
    opts?.budget,
    { maxMicro: rules.maxMicro, pointValue: opts?.pointValue ?? 2 },
  );

  const evalSim = simulateAccount(d, "eval", 0, rules);
  const fundedSim = simulateAccount(d, "funded", 0, rules);
  const evalTest = splitDate ? simulateAccount(d.filter((t) => t.date >= splitDate), "eval", 0, rules) : null;
  const fundedTest = splitDate ? simulateAccount(d.filter((t) => t.date >= splitDate), "funded", 0, rules) : null;

  // max drawdown on the dollarized equity curve (date order)
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of d) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // daily P&L totals for the reshuffle
  const byDate = new Map<string, number>();
  for (const t of d) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.pnl);
  const daily = [...byDate.values()];
  let pPass: number | null = null;
  let medianDaysToPass: number | null = null;
  if (daily.length >= 2) {
    const rand = mulberry32(seed);
    let passes = 0;
    const daysToPass: number[] = [];
    for (let it = 0; it < iters; it++) {
      const shuffled = [...daily];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // synthetic ascending date labels preserve the shuffled order
      // (simulateAccount replays in calendar order)
      const rows = shuffled.map((pnl, i) => ({ date: `d${String(i).padStart(4, "0")}`, pnl }));
      const sim = simulateAccount(rows, "eval", 0, rules);
      if (sim.passDay && !sim.breachDay) {
        passes++;
        daysToPass.push(sim.tradingDays);
      }
    }
    if (passes > 0) {
      const sorted = daysToPass.sort((a, b) => a - b);
      medianDaysToPass = sorted[Math.floor(sorted.length / 2)];
    }
    // 0% is a real answer ("no ordering passed"), null = not computable
    pPass = passes / iters;
  }

  return { evalSim, fundedSim, evalTest, fundedTest, maxDdUsd: maxDd, mllRatio: rules.maxLoss > 0 ? maxDd / rules.maxLoss : 0, pPass, medianDaysToPass, iters };
}

/* ================= 4. standard renderers ================= */

export const fmtPts = (n: number, dp = 2): string => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;
export const fmtPct = (n: number, dp = 1): string => `${n.toFixed(dp)}%`;
export const fmtPf = (pf: number): string => (Number.isFinite(pf) ? pf.toFixed(2) : "—");
const dash = (v: number | null | undefined, f: (n: number) => string) => (v === null || v === undefined ? "—" : f(v));

/** T1 — the core quality table (docs/BACKTEST-REPORT-STANDARD.md §4). */
export function renderT1(rows: { label: string; stats: CoreStats }[]): string {
  const L: string[] = [];
  L.push("| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const s = r.stats;
    const wr = s.n ? `${fmtPct(s.wr)} [${fmtPct(s.wrCi[0])}–${fmtPct(s.wrCi[1])}]` : "—";
    const avgWin = s.wins > 0 ? fmtPts(s.avgWin) : "—";
    const avgLoss = s.losses > 0 ? s.avgLoss.toFixed(2) : "—"; // magnitude, no sign
    const payoff = Number.isFinite(s.payoff) && s.losses > 0 ? s.payoff.toFixed(2) : "—";
    L.push(
      `| ${r.label} | ${s.n} | ${wr} | ${avgWin} | ${avgLoss} | ${payoff} | ${fmtPts(s.expPts)} | ${fmtPts(s.expR)} | ` +
        `${fmtPf(s.pf)} | ${dash(Number.isFinite(s.sqn) ? s.sqn : null, (v) => v.toFixed(1))} | ${s.maxDdPts.toFixed(1)} | ` +
        `${dash(Number.isFinite(s.sharpeSess) ? s.sharpeSess : null, (v) => v.toFixed(2))} | ${s.concTop10.toFixed(1)}% |`,
    );
  }
  return L.join("\n");
}

/** T2 — one row per rule/cell; n first, comparison column last. */
export type T2Row = {
  rule: string;
  n: number;
  wr: number; // percent
  ci?: [number, number];
  pf: number;
  expPts: number;
  trainTest?: string; // e.g. "88% / 88%"
  compare?: string; // baseline / opposite side
};

export function renderT2(rows: T2Row[]): string {
  const L: string[] = [];
  L.push("| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |");
  L.push("|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    const wr = r.ci ? `${fmtPct(r.wr)} [${fmtPct(r.ci[0])}–${fmtPct(r.ci[1])}]` : fmtPct(r.wr);
    L.push(`| ${i + 1} | ${r.rule} | ${r.n} | ${wr} | ${fmtPf(r.pf)} | ${fmtPts(r.expPts)} | ${r.trainTest ?? "—"} | ${r.compare ?? "—"} |`);
  });
  return L.join("\n");
}

/** T4 — the prop-account viability table; `extra` appends guarded rows. */
export function renderT4(v: Viability, extra?: { stage: string; sim: AccountSimResult; note?: string }[]): string {
  const L: string[] = [];
  L.push("| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const row = (stage: string, sim: AccountSimResult, note = "") => {
    const out = accountLine(sim) + (note ? ` · ${note}` : "");
    const breach = sim.breachDay ? `${sim.breachDay} ($${sim.breachEquity?.toFixed(0)})` : "—";
    const pass = sim.passDay ? `${sim.passDay} ($${sim.passEquity?.toFixed(0)})` : "—";
    L.push(
      `| ${stage} | ${sim.rules} | ${sim.nTrades} | ${sim.tradingDays} | $${sim.totalProfit.toFixed(0)} | $${sim.bestDay.toFixed(0)} | ` +
        `${stage === "eval" ? (sim.consistencyOk ? "✓" : "✗") : "—"} | ${stage === "eval" ? (sim.minDaysOk ? "✓" : "✗") : "—"} | ` +
        `${breach} | ${pass} | ${stage === "funded" ? sim.payouts : "—"} | ${out} |`,
    );
  };
  row("eval", v.evalSim);
  row("funded", v.fundedSim);
  if (v.evalTest) row("eval (test-only)", v.evalTest);
  if (v.fundedTest) row("funded (test-only)", v.fundedTest);
  for (const e of extra ?? []) row(e.stage, e.sim, e.note ?? "");
  L.push("");
  L.push(
    `P(pass before breach) = ${v.pPass === null ? "—" : fmtPct(v.pPass * 100, 0)} · median days to pass = ${v.medianDaysToPass ?? "—"} · maxDD $${v.maxDdUsd.toFixed(0)} = ${fmtPct(v.mllRatio * 100, 0)} of MLL (${v.iters} reshuffles)`,
  );
  return L.join("\n");
}

/** The five-slot verdict line. */
export function renderVerdict(slots: { edge?: string; significance?: string; stability?: string; holdout?: string; viability?: string }): string {
  const parts = [
    slots.edge ? `edge ${slots.edge}` : null,
    slots.significance ? `significance ${slots.significance}` : null,
    slots.stability ? `stability ${slots.stability}` : null,
    slots.holdout ? `holdout ${slots.holdout}` : null,
    slots.viability ? `viability ${slots.viability}` : null,
  ].filter(Boolean);
  return `VERDICT: ${parts.join(" · ")}`;
}

/** T0 — the study card.
 *
 *  Every study must declare its STACK: which ONE layer it varies against
 *  the frozen production stack (docs/architecture/RESEARCH-LOOP.md).
 *  renderT0 injects the Stack row when the caller didn't supply one —
 *  an undeclared varying layer is printed as-is, never guessed. */
export const PRODUCTION_STACK =
  "signals *_PROD (registry) · gates default set · risk challengeRules+guardCore · fill 0.5pt/close-entry";

export function renderT0(fields: Record<string, string>): string {
  const entries: [string, string][] = Object.entries(fields);
  const hasStack = entries.some(([k]) => k === "Stack");
  const stackRow: [string, string] = ["Stack", fields["Stack"] ?? `${PRODUCTION_STACK} — varying layer NOT declared`];
  const rows = hasStack
    ? entries
    : (() => {
        const idx = entries.findIndex(([k]) => k === "CLI");
        const copy = [...entries];
        copy.splice(idx === -1 ? copy.length : idx, 0, stackRow);
        return copy;
      })();
  const L = ["| Field | Value |", "|---|---|"];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  return L.join("\n");
}
