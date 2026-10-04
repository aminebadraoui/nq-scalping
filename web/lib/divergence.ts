/* ------------------------------------------------------------------ *
 * CVD divergence (D2/D4) — the single definition shared by the
 * session analysis (lib/gcdata.ts) and the footprint ladder's per-bar
 * strip (components/MinuteNavigator.tsx).
 *
 * D2 (bullish): a pivot LOW lower than the prior pivot low while
 * cumulative delta is HIGHER than at the prior pivot.
 * D4 (bearish): a pivot HIGH higher than the prior pivot high while
 * cumulative delta is LOWER than at the prior pivot.
 * Pivot = strict ±2-bar local extreme (same definition the analysis
 * tests recompute independently).
 *
 * Pure, unit-tested (tests/divergence.test.mjs).
 * ------------------------------------------------------------------ */

export type Divergence = {
  /** bar index in the input array */
  index: number;
  kind: "D2" | "D4";
  bias: "bull" | "bear";
  price: number;
};

export type DivBar = { high: number; low: number; buy: number; sell: number };

/** running buy−sell over the array (the CVD line) */
export function cumulativeDelta(bars: { buy: number; sell: number }[]): number[] {
  let cum = 0;
  return bars.map((b) => (cum += b.buy - b.sell));
}

export function computeDivergences(bars: DivBar[]): Divergence[] {
  const n = bars.length;
  if (n < 5) return [];
  const lo = bars.map((b) => b.low);
  const hi = bars.map((b) => b.high);
  const cvd = cumulativeDelta(bars);

  const pLows: number[] = [];
  const pHighs: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (lo[i] < Math.min(lo[i - 1], lo[i - 2], lo[i + 1], lo[i + 2])) pLows.push(i);
    if (hi[i] > Math.max(hi[i - 1], hi[i - 2], hi[i + 1], hi[i + 2])) pHighs.push(i);
  }

  const out: Divergence[] = [];
  for (let k = 1; k < pLows.length; k++) {
    const i1 = pLows[k - 1];
    const i2 = pLows[k];
    if (lo[i2] < lo[i1] && cvd[i2] > cvd[i1]) out.push({ index: i2, kind: "D2", bias: "bull", price: lo[i2] });
  }
  for (let k = 1; k < pHighs.length; k++) {
    const i1 = pHighs[k - 1];
    const i2 = pHighs[k];
    if (hi[i2] > hi[i1] && cvd[i2] < cvd[i1]) out.push({ index: i2, kind: "D4", bias: "bear", price: hi[i2] });
  }
  return out;
}
