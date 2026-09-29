/* ------------------------------------------------------------------ *
 * "Usual volume" baseline, by New York hour.
 *
 * Median minute volume across 640 complete ETH sessions (2.5 years).
 * Volume varies ~30× by hour (thin overnight vs thick RTH), so a single
 * session-wide median is the wrong reference: it's trivially beaten in
 * RTH and barely reachable overnight. Compare a bar to the median of ITS
 * hour instead — that is "relative volume" (RVOL), and ≥2× is the useful
 * "unusual volume" flag.
 * ------------------------------------------------------------------ */

export const HOURLY_MEDIAN_VOLUME: Record<number, number> = {
  0: 37,
  1: 49,
  2: 68,
  3: 106,
  4: 107,
  5: 80,
  6: 83,
  7: 118,
  8: 204,
  9: 948,
  10: 1349,
  11: 917,
  12: 689,
  13: 615,
  14: 606,
  15: 770,
  16: 139,
  17: 0, // 17:00–18:00 NY is the daily halt — no trading
  18: 63,
  19: 56,
  20: 76,
  21: 63,
  22: 49,
  23: 40,
};

/** relative volume: a bar's volume ÷ the median minute volume of its hour. */
export function rvol(etHour: number, volume: number): number {
  const base = HOURLY_MEDIAN_VOLUME[((etHour % 24) + 24) % 24];
  if (!base) return 0;
  return volume / base;
}

/** "unusual volume" flag — ≥2× the hourly norm. */
export function isUnusualVolume(etHour: number, volume: number): boolean {
  return rvol(etHour, volume) >= 2;
}
