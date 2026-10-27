/* ------------------------------------------------------------------ *
 * Shared order statistics. Two medians on purpose — they are NOT
 * interchangeable, and every caller's numbers were measured with the
 * one it uses:
 *
 *   upperMedian  s[floor(n/2)] — the detector convention (the upper of
 *                the two middle values on even samples). The volume and
 *                range gates of the signal families were calibrated with
 *                it; switching a detector to `median` changes its gates.
 *   median       the textbook median (mean of the two middle values).
 *
 * Both return 0 for an empty sample and never mutate the input. Pure.
 * ------------------------------------------------------------------ */

export function upperMedian(a: readonly number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function median(a: readonly number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
