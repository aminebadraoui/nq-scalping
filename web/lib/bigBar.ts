/* ------------------------------------------------------------------ *
 * Big-bar continuation (family D) — the reverse-engineered macro-day
 * capture pattern (docs/research/reverse-engineered-patterns-2026-10-15.md):
 *
 *   the session's FIRST bar with range ≥ 100 pts, continued in its delta
 *   direction. Rides the momentum card's flush-limit path (resting limit
 *   AT the bar's close, TTL 9, brackets rebuilt from the fill, 1R target)
 *   — the D-limit study arm (n=107, 57.0% WR, PF 1.42, +4.63 pts/trade,
 *   train/test 52/62): the harvestable version of the pattern. The
 *   idealized market-entry arm (PF 3.74) is the unreachable close-fill
 *   fantasy — the chase wall applies here exactly like the flush family.
 *
 *   Risk = max(3.5, ATR14) at the trigger bar (~29 pts on macro days →
 *   1 micro at the $100 budget). ONE candidate per session (the study's
 *   one-per-day semantics); news-blackout bars are recorded as skips by
 *   the signal feed, no re-arm.
 * ------------------------------------------------------------------ */

import type { MomentumSignal } from "./momentum";

export const BIGBAR_MIN_RANGE = 100; // pts
export const BIGBAR_ATR_FLOOR = 3.5; // pts (the house widen floor)
export const BIGBAR_PREFIX_SKIP = 30; // the study's session-prefix skip

/** minimal minute shape the detector reads (MomMinute / FootprintMinute
 *  both satisfy it) */
export type BigBarMinute = {
  t: string;
  d: string;
  high: number;
  low: number;
  buy: number;
  sell: number;
  c: number;
};

/** the first bar with range ≥ BIGBAR_MIN_RANGE past the prefix skip,
 *  traded in its delta direction — or null when the session has none.
 *  Emits a `kind: "flush"` MomentumSignal so the live card path reuses
 *  the flush-limit machinery unchanged (limit at the close, TTL 9). */
export function detectBigBar(minutes: BigBarMinute[]): MomentumSignal | null {
  const n = minutes.length;
  if (n < BIGBAR_PREFIX_SKIP + 1) return null;
  // prefix ATR14 (mean of the last 14 ranges) — lookahead-free, same
  // convention as reverseEngineerStudy.ts familyD
  const atr: number[] = new Array(n).fill(0);
  let rsum = 0;
  const rbuf: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = minutes[i].high - minutes[i].low;
    rbuf.push(r);
    rsum += r;
    if (rbuf.length > 14) rsum -= rbuf.shift()!;
    atr[i] = rsum / Math.max(1, rbuf.length);
  }
  for (let k = BIGBAR_PREFIX_SKIP; k < n; k++) {
    const m = minutes[k];
    if (m.high - m.low < BIGBAR_MIN_RANGE) continue;
    const vol = m.buy + m.sell;
    if (vol <= 0) continue;
    const delta = m.buy - m.sell;
    if (delta === 0) continue;
    const dir = delta > 0 ? ("long" as const) : ("short" as const);
    const dirSign = dir === "long" ? 1 : -1;
    const entry = m.c > 0 ? m.c : (m.high + m.low) / 2;
    const risk = Math.max(BIGBAR_ATR_FLOOR, atr[k]);
    const buyFrac = m.buy / vol;
    const rangeR = (m.high - m.low) / Math.max(0.1, atr[k]);
    return {
      dir,
      kind: "flush",
      flushIdx: k,
      respIdx: k,
      breakIdx: k,
      entryIdx: k,
      entry,
      stop: entry - dirSign * risk,
      target: entry + dirSign * risk,
      risk,
      t: m.t,
      d: m.d,
      hourET: (Number(m.t.slice(0, 2)) + 1) % 24,
      flushFrac: buyFrac,
      flushVol: vol,
      flushRange: m.high - m.low,
      failDepth: 0,
      respFrac: buyFrac,
      respVol: vol,
      respDelay: 0,
      respProof: 0,
      breakFrac: buyFrac,
      breakVol: vol,
      breakDelay: 0,
      refDist: 0,
      progressPts: 0,
      medVol: vol,
      distVwapPts: 0,
      cumDelta: delta,
      deltaFromFlush: delta,
      atr14: atr[k],
      riskPts: risk,
      breakRangeR: rangeR,
      breakStack: "none",
      breakVwapPos: 0,
      flushRangeR: rangeR,
      trailLowDist: 0,
      trailHighDist: 0,
    };
  }
  return null;
}
