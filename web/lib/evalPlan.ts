/* ------------------------------------------------------------------ *
 * Eval plan v1 (2026-10-27) — the two strategies that survived the
 * honest-fill research (research_notes/mff-eval-math-2026-10-27):
 *
 *  1. NOISE-AREA intraday momentum (Zarattini, Aziz & Barbon 2024):
 *     sigma(k) = mean over the prior 14 sessions of |close(k)/open − 1|
 *     at RTH minute k; UB = max(open, prevClose)·(1+sigma),
 *     LB = min(open, prevClose)·(1−sigma). At the bars that END on
 *     :00/:30 from 10:30 ET, go long above UB / short below LB (market).
 *     Trailing stop = max(UB, VWAP) long / min(LB, VWAP) short, flat 15:59.
 *  2. GAP FADE: |9:30 open − prior 16:00 close| > 0.25% → trade back
 *     toward the prior close at market, stop = the gap size from the
 *     fill, out by 11:00 ET. Skipped when the stop would exceed
 *     GAP_MAX_STOP_PTS (150).
 *
 * Pure: no IO, no timers, no env. The live wiring is in signalFeed
 * (checkEvalPlan) and the history loader in lib/evalPlanHistory.ts.
 * Times are FEED-clock (Chicago) "HH:MM": RTH = 08:30–14:59.
 * ------------------------------------------------------------------ */

import { closeEstimate, marketFillEstimate, type FillBar } from "./honestFill";

export const RTH_START_MIN = 8 * 60 + 30; // 08:30 feed clock = 09:30 ET
export const RTH_BARS = 390;
export const NA_LOOKBACK = 14;
export const GAP_MIN_FRAC = 0.0025;
export const GAP_MAX_STOP_PTS = 150;

export const feedMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** RTH minute index of a feed-clock bar (0 = the 09:30 ET bar), or −1 */
export function rthIndex(t: string): number {
  const k = feedMin(t) - RTH_START_MIN;
  return k >= 0 && k < RTH_BARS ? k : -1;
}

export type Bar = FillBar & { t: string };

/** the session's RTH open: the 09:30 bar's true open when known, else the
 *  unbiased next-open estimate from the 09:29 bar (the backtest rule) */
export function rthOpen(bars: Bar[]): number | null {
  const i = bars.findIndex((b) => rthIndex(b.t) === 0);
  if (i < 0) return null;
  if ((bars[i].o ?? 0) > 0) return bars[i].o as number;
  return i > 0 ? marketFillEstimate(bars[i - 1], 1, "p50") : null;
}

/** price at the end of bar b (true close when known, else the median estimate) */
export const barClose = (b: FillBar): number => ((b.c ?? 0) > 0 ? (b.c as number) : closeEstimate(b));

/** |close(k)/open − 1| for every RTH minute of one session (NaN where missing) */
export function sessionMoves(bars: Bar[]): number[] | null {
  const op = rthOpen(bars);
  if (op === null || !(op > 0)) return null;
  const mv = new Array<number>(RTH_BARS).fill(NaN);
  for (const b of bars) {
    const k = rthIndex(b.t);
    if (k >= 0) mv[k] = Math.abs(barClose(b) / op - 1);
  }
  return mv;
}

/** the prior session's 16:00 ET close: the end of its 14:59 feed-clock bar */
export function sessionClose(bars: Bar[]): number | null {
  const b = bars.find((x) => rthIndex(x.t) === RTH_BARS - 1);
  return b ? barClose(b) : null;
}

/** mean move per RTH minute over the prior sessions (needs ≥ NA_LOOKBACK) */
export function noiseSigma(prior: number[][]): number[] | null {
  const use = prior.slice(-NA_LOOKBACK);
  if (use.length < NA_LOOKBACK) return null;
  const out = new Array<number>(RTH_BARS).fill(NaN);
  for (let k = 0; k < RTH_BARS; k++) {
    let s = 0, n = 0;
    for (const mv of use) if (Number.isFinite(mv[k])) { s += mv[k]; n++; }
    out[k] = n > 0 ? s / n : NaN;
  }
  return out;
}

export type Bands = { ub: number[]; lb: number[] };
export function noiseBands(open: number, prevClose: number, sigma: number[]): Bands {
  const hi = Math.max(open, prevClose), lo = Math.min(open, prevClose);
  return { ub: sigma.map((s) => hi * (1 + s)), lb: sigma.map((s) => lo * (1 - s)) };
}

/** a noise-area check bar: the bar that ENDS at :00 or :30, from 10:30 ET
 *  (feed clock: bars starting 09:29, 09:59, … 14:29) — the schedule the
 *  backtest that supports this plan actually ran (its first check was the
 *  bar ending 10:30; the paper's text says 10:00) */
export function isCheckBar(t: string): boolean {
  const k = rthIndex(t);
  return k >= 59 && k < RTH_BARS - 1 && (feedMin(t) % 30) === 29;
}

/** entry decision at a check bar: +1 / −1 / 0 */
export function noiseEntry(k: number, price: number, b: Bands): 1 | -1 | 0 {
  if (!(k >= 0 && k < RTH_BARS) || !Number.isFinite(b.ub[k]) || !Number.isFinite(b.lb[k])) return 0;
  if (price > b.ub[k]) return 1;
  if (price < b.lb[k]) return -1;
  return 0;
}

/** the trailing stop after bar k: max(UB, VWAP) long / min(LB, VWAP) short */
export function noiseStop(dir: 1 | -1, k: number, b: Bands, vwap: number): number {
  return dir > 0 ? Math.max(b.ub[k], vwap) : Math.min(b.lb[k], vwap);
}

/** RTH VWAP through each completed RTH bar (minute vwap × volume) */
export function rthVwap(bars: (Bar & { vwap?: number })[]): Map<number, number> {
  const out = new Map<number, number>();
  let pv = 0, v = 0;
  for (const b of bars) {
    const k = rthIndex(b.t);
    if (k < 0) continue;
    const vol = (b.buy ?? 0) + (b.sell ?? 0);
    const px = b.vwap && b.vwap > 0 ? b.vwap : (b.high + b.low) / 2;
    pv += px * vol; v += vol;
    out.set(k, v > 0 ? pv / v : px);
  }
  return out;
}

export type GapTrade = { dir: 1 | -1; stopPts: number; gapFrac: number };
/** gap-fade decision at the RTH open */
export function gapDecision(open: number, prevClose: number, opts?: { minFrac?: number; maxStopPts?: number }): GapTrade | null {
  if (!(open > 0) || !(prevClose > 0)) return null;
  const g = (open - prevClose) / prevClose;
  if (Math.abs(g) <= (opts?.minFrac ?? GAP_MIN_FRAC)) return null;
  const stopPts = Math.abs(open - prevClose);
  if (stopPts > (opts?.maxStopPts ?? GAP_MAX_STOP_PTS)) return null;
  return { dir: g > 0 ? -1 : 1, stopPts: Math.round(stopPts * 4) / 4, gapFrac: g };
}
