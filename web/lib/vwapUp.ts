/* ------------------------------------------------------------------ *
 * VWAP-UP — intraday-uptrend first pullback to session VWAP (long only).
 *
 * Found by gcdata/new_edge_lab.py (docs/research/new-edge-lab-2026-10-26.md)
 * on 614 sessions of real Tradovate 1-min OHLCV with pessimistic
 * execution (fill-bar stop-first, 0.25 pt slip, $1.90/RT): long-only
 * first touch PF 1.40, +0.23R, train/test PF 1.44 / 1.32, every year
 * positive, beats a blind-long drift baseline (PF 0.91–1.04).
 *
 * Rule, evaluated for the UPCOMING bar i from the completed bars:
 *   - RTH (08:30–15:00 CT), i at/after 09:30 CT (10:30 ET) and before
 *     14:00 CT (15:00 ET)
 *   - the last TREND_BARS completed bars all have low > session VWAP
 *     (at that bar) and VWAP rose over the window
 *   - arm: a buy LIMIT at VWAP of the last completed bar for bar i only
 *   - one trade per day: the day is DONE at the first bar that touched
 *     an armed level (filled or not — the backtest's first-touch rule)
 * Bracket: stop LEVEL − 25, target LEVEL + 50, flat at the 16:00 ET close.
 * Session VWAP = Σ((H+L+C)/3 · vol) / Σ vol from the RTH open.
 * Pure + unit-tested; no I/O.
 * ------------------------------------------------------------------ */

export type VwapBar = { t: string; d: string; o: number; c: number; high: number; low: number; buy: number; sell: number };

export const VWAPUP_PROD = {
  trendBars: 30,
  stopPts: 25,
  targetPts: 50,
  /** CT minute-of-day bounds for the bar the limit rests in */
  firstArmCt: 9 * 60 + 30,
  lastArmCt: 14 * 60,
};
export type VwapUpConfig = typeof VWAPUP_PROD;

const RTH_OPEN_CT = 8 * 60 + 30;
const RTH_CLOSE_CT = 15 * 60;

export const minuteOfDay = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const closeOf = (b: VwapBar): number => (b.c > 0 ? b.c : (b.high + b.low) / 2);

/** session VWAP after each RTH bar (index-aligned with `rth`) */
export function sessionVwap(rth: VwapBar[]): number[] {
  let pv = 0;
  let vv = 0;
  return rth.map((b) => {
    const v = Math.max(1, (b.buy || 0) + (b.sell || 0));
    pv += ((b.high + b.low + closeOf(b)) / 3) * v;
    vv += v;
    return pv / vv;
  });
}

/** the trend condition for bar index i (uses bars i−trendBars … i−1) */
function armedFor(rth: VwapBar[], vw: number[], i: number, cfg: VwapUpConfig): boolean {
  if (i < cfg.trendBars) return false;
  const m = minuteOfDay(rth[i - 1].t) + 1; // the upcoming bar's minute
  if (m < cfg.firstArmCt || m >= cfg.lastArmCt) return false;
  for (let k = i - cfg.trendBars; k < i; k++) if (!(rth[k].low > vw[k])) return false;
  return vw[i - 1] - vw[i - cfg.trendBars] > 0;
}

export type VwapUpState = {
  d: string | null;
  /** a qualifying touch already happened today (the one trade is spent) */
  done: boolean;
  /** rest a buy limit at `level` for the bar starting at `armT` (CT) */
  arm: { armT: string; level: number; stop: number; target: number } | null;
};

/** today's state from the COMPLETED bars (the last bar's session day) */
export function vwapUpState(bars: VwapBar[], cfg: VwapUpConfig = VWAPUP_PROD): VwapUpState {
  const last = bars[bars.length - 1];
  if (!last) return { d: null, done: false, arm: null };
  const rth = bars.filter((b) => b.d === last.d && minuteOfDay(b.t) >= RTH_OPEN_CT && minuteOfDay(b.t) < RTH_CLOSE_CT);
  if (!rth.length) return { d: last.d, done: false, arm: null };
  const vw = sessionVwap(rth);
  // first-touch rule: any completed bar i that was armed AND touched its level
  for (let i = cfg.trendBars; i < rth.length; i++) {
    if (armedFor(rth, vw, i, cfg) && rth[i].low <= vw[i - 1]) return { d: last.d, done: true, arm: null };
  }
  const i = rth.length; // the upcoming bar
  // the upcoming bar must directly follow the last completed bar inside RTH
  if (last !== rth[rth.length - 1] || !armedFor(rth, vw, i, cfg)) return { d: last.d, done: false, arm: null };
  const m = minuteOfDay(rth[i - 1].t) + 1;
  const armT = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const level = Math.floor(vw[i - 1] * 4) / 4; // MNQ tick, at/below VWAP (a touch of it is a touch of VWAP)
  return { d: last.d, done: false, arm: { armT, level, stop: level - cfg.stopPts, target: level + cfg.targetPts } };
}

/** fixed-risk sizing: floor(budget / (stop · $2)), at least 1 micro */
export function vwapUpContracts(budgetUsd: number, stopPts: number = VWAPUP_PROD.stopPts): number {
  return Math.max(1, Math.floor(budgetUsd / (stopPts * 2)));
}
