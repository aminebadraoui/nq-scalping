/* ------------------------------------------------------------------ *
 * REGIME CHIPS — pure, lookahead-free regime context for journal
 * labels (the vol/EMA200/HTF cells measured in
 * docs/research/regime-conditioned-2026-10-15.md).
 *
 * STATUS: journal-only module. NOT imported by any live module — wiring
 * it into the card text is a LIVE-EXEC change (signalFeed/signalText)
 * and follows EXEC_CHANGE_POLICY: backtest reference
 * `[backtested: scripts/regimeConditionedStudy.ts --offline]`, tests,
 * and the deploy-window discipline. Labels never gate.
 *
 * Semantics copied from web/scripts/htfRegimeStudy.ts (the measured
 * implementation):
 *   · 1m EMA200 over mid closes (k = 2/201), 30-bar slope for "rising"
 *   · 15m buckets (15 bars from index 14) → EMA20 vs EMA50 over bucket
 *     mids, 1-hour slope confirm (bucket −4) → BULL15 / BEAR15
 *   · warmup: the regime is EARLY until ≥ 4 completed buckets (b ≥ 4)
 *
 * Vol band thresholds = the TRAIN terciles measured by the regime study
 * (0.5 pt cost replay, per family — snapshot 2026-10-15). These are
 * labels: the live tape's ATR14 is built from the tick stream and can
 * differ from the vendor candles the archive stores (live-vs-backtest
 * divergence, docs/research/live-vs-backtest-2026-10-05.md).
 * ------------------------------------------------------------------ */

import { closeOf, type MomMinute } from "./momentum";

export type HtfState = "BULL15" | "BEAR15" | "MIXED" | "EARLY";
export type VolBand = "LOW" | "MID" | "HIGH";

export type RegimeChip = {
  htf: HtfState;
  above200: boolean;
  ema200Rising: boolean;
  volBand: VolBand | null; // null when the family has no measured thresholds
};

/** train-tercile thresholds per family, measured 2026-10-15
 *  (regime-conditioned-2026-10-15.md §Q2). */
export const VOL_THRESHOLDS: Record<string, { q1: number; q2: number } | null> = {
  failed_flush_breakout: { q1: 3, q2: 5 },
  huge_bar_expansion: { q1: 3, q2: 5 },
  session_continuation: { q1: 8, q2: 12 },
};

export type RegimeContext = {
  mid: number[];
  ema200: number[];
  ema200Prev30: number[];
  bucketEnd: number[];
  bucketMid: number[];
  bucketEma20: number[];
  bucketEma50: number[];
};

/** one-pass context over a session's minutes (lookahead-free by
 *  construction — every array value at index i uses bars ≤ i). */
export function buildRegimeContext(minutes: MomMinute[]): RegimeContext {
  const n = minutes.length;
  const mid: number[] = new Array(n);
  const ema200: number[] = new Array(n);
  const ema200Prev30: number[] = new Array(n);
  let e = 0;
  const k = 2 / 201;
  for (let i = 0; i < n; i++) {
    mid[i] = closeOf(minutes[i]);
    e = e === 0 ? mid[i] : e + k * (mid[i] - e);
    ema200[i] = e;
    ema200Prev30[i] = i >= 30 ? ema200[i - 30] : ema200[i];
  }
  const bucketEnd: number[] = [];
  const bucketMid: number[] = [];
  for (let i = 14; i < n; i += 15) {
    bucketEnd.push(i);
    bucketMid.push(mid[i]);
  }
  const nb = bucketMid.length;
  const bucketEma20: number[] = new Array(nb);
  const bucketEma50: number[] = new Array(nb);
  if (nb > 0) {
    let e20 = bucketMid[0];
    let e50 = bucketMid[0];
    const k20 = 2 / 21;
    const k50 = 2 / 51;
    for (let i = 0; i < nb; i++) {
      e20 = i === 0 ? e20 : e20 + k20 * (bucketMid[i] - e20);
      e50 = i === 0 ? e50 : e50 + k50 * (bucketMid[i] - e50);
      bucketEma20[i] = e20;
      bucketEma50[i] = e50;
    }
  }
  return { mid, ema200, ema200Prev30, bucketEnd, bucketMid, bucketEma20, bucketEma50 };
}

/** the regime at a signal's entry bar; null when the 15m buckets have no
 *  completed bar before the entry (b < 0 — the study's tagRegime drop). */
export function regimeChipOf(ctx: RegimeContext, entryIdx: number, entry: number, atr14: number, family: string): RegimeChip | null {
  let b = -1;
  for (let k = 0; k < ctx.bucketEnd.length; k++) {
    if (ctx.bucketEnd[k] <= entryIdx) b = k;
    else break;
  }
  if (b < 0) return null;
  const mature = b >= 4;
  const e20 = ctx.bucketEma20[b];
  const e50 = ctx.bucketEma50[b];
  const e20Prev = mature ? ctx.bucketEma20[b - 4] : e20;
  const bull15 = mature && e20 > e50 && e20 >= e20Prev;
  const bear15 = mature && e20 < e50 && e20 <= e20Prev;
  const th = VOL_THRESHOLDS[family] ?? null;
  return {
    htf: !mature ? "EARLY" : bull15 ? "BULL15" : bear15 ? "BEAR15" : "MIXED",
    above200: entry > ctx.ema200[entryIdx],
    ema200Rising: ctx.ema200[entryIdx] >= ctx.ema200Prev30[entryIdx],
    volBand: th ? (atr14 <= th.q1 ? "LOW" : atr14 > th.q2 ? "HIGH" : "MID") : null,
  };
}
