/* ------------------------------------------------------------------ *
 * Higher-timeframe swing structure — daily + weekly HH/HL vs LH/LL
 * vs CHOP, computed from the system's own 1-minute archive (zero new
 * feeds). Display-only context today; the sizing experiments built on
 * it live in web/scripts (htfRegimeStudy.ts family).
 *
 * Definitions (pure, unit-tested in tests/htfStructure.test.mjs):
 *   - bar: aggregated high/low per ET day (daily) / Mon–Fri week (weekly)
 *   - swing: fractal pivot — a high above the 2 bars on each side
 *     (pivot high) or a low below them (pivot low)
 *   - structure: compare the last two pivot highs AND the last two
 *     pivot lows:
 *       HH/HL  = higher high AND higher low            → uptrend
 *       LH/LL  = lower high AND lower low              → downtrend
 *       CHOP   = mixed highs/lows, or the recent range
 *                compressed below 40% of its own 60-bar average
 *                (inside-bar tape), or too few pivots
 * ------------------------------------------------------------------ */

export type Structure = "HH/HL" | "LH/LL" | "CHOP";

export type Bar = { day: string; high: number; low: number };

/** group per-minute bars into ET-day bars (newest last) */
export function dailyBars(minutes: { t: string; high: number; low: number }[]): Bar[] {
  const map = new Map<string, { high: number; low: number }>();
  for (const m of minutes) {
    const day = m.t.slice(0, 10);
    const e = map.get(day);
    if (!e) map.set(day, { high: m.high, low: m.low });
    else {
      if (m.high > e.high) e.high = m.high;
      if (m.low < e.low) e.low = m.low;
    }
  }
  const out = [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => ({ day, high: v.high, low: v.low }));
  return out;
}

/** group daily bars into Mon–Fri trading weeks (keyed by the Monday) */
export function weeklyBars(daily: Bar[]): Bar[] {
  const map = new Map<string, { high: number; low: number }>();
  for (const d of daily) {
    const [y, m, dd] = d.day.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, dd));
    const dow = dt.getUTCDay(); // 0 = Sun
    const monday = new Date(Date.UTC(y, m - 1, dd - ((dow + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    const e = map.get(key);
    if (!e) map.set(key, { high: d.high, low: d.low });
    else {
      if (d.high > e.high) e.high = d.high;
      if (d.low < e.low) e.low = d.low;
    }
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, v]) => ({ day, high: v.high, low: v.low }));
}

/** fractal pivot indices (±2 bars) */
export function pivotHighs(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].high > Math.max(bars[i - 1].high, bars[i - 2].high, bars[i + 1].high, bars[i + 2].high)) out.push(i);
  }
  return out;
}

export function pivotLows(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < Math.min(bars[i - 1].low, bars[i - 2].low, bars[i + 1].low, bars[i + 2].low)) out.push(i);
  }
  return out;
}

/** chop test: neither side has printed a fresh pivot recently. A
 *  trending tape keeps making pivot highs AND lows (pullbacks); an
 *  inside/dead tape stops making extremes. The staleness window scales
 *  with series length — healthy trends pause 10–30 bars between pivots,
 *  so a fixed short window would mislabel them as chop. */
export function isChop(bars: Bar[], staleBars?: number): boolean {
  if (bars.length < 6) return true;
  const stale = staleBars ?? Math.max(6, Math.floor(bars.length / 4));
  const hs = pivotHighs(bars);
  const ls = pivotLows(bars);
  const fresh = (idx: number | undefined) => idx !== undefined && bars.length - 1 - idx <= stale;
  return !fresh(hs[hs.length - 1]) && !fresh(ls[ls.length - 1]);
}

/** the structure label: HH/HL · LH/LL · CHOP.
 *  Pivot HIGHS are strict ±2 fractals; the swing LOWS compared against
 *  each other are the minimum lows of the SEGMENTS between consecutive
 *  pivot highs (the pullbacks). This is what makes an uptrend nameable:
 *  pullback lows do not need to be fractals themselves. The mirrored
 *  lows-based path handles clean downtrends the same way. */
export function classifyStructure(bars: Bar[]): Structure {
  if (bars.length < 6 || isChop(bars)) return "CHOP";

  const hs = pivotHighs(bars);
  if (hs.length >= 2) {
    const h1 = hs[hs.length - 2];
    const h2 = hs[hs.length - 1];
    const minLow = (from: number, to: number) => Math.min(...bars.slice(from + 1, to + 1).map((b) => b.low));
    const l1 = minLow(hs.length >= 3 ? hs[hs.length - 3] : -1, h1);
    const l2 = minLow(h1, h2);
    const hh = bars[h2].high > bars[h1].high;
    const lh = bars[h2].high < bars[h1].high;
    const hl = l2 > l1;
    const ll = l2 < l1;
    if (hh && hl) return "HH/HL";
    if (lh && ll) return "LH/LL";
  }

  const ls = pivotLows(bars);
  if (ls.length >= 2) {
    const l1 = ls[ls.length - 2];
    const l2 = ls[ls.length - 1];
    const maxHigh = (from: number, to: number) => Math.max(...bars.slice(from + 1, to + 1).map((b) => b.high));
    const h1 = maxHigh(ls.length >= 3 ? ls[ls.length - 3] : -1, l1);
    const h2 = maxHigh(l1, l2);
    const hh = h2 > h1;
    const lh = h2 < h1;
    const hl = bars[l2].low > bars[l1].low;
    const ll = bars[l2].low < bars[l1].low;
    if (hh && hl) return "HH/HL";
    if (lh && ll) return "LH/LL";
  }

  return "CHOP";
}

/** daily + weekly read from raw minutes */
export function htfStructure(minutes: { t: string; high: number; low: number }[]): { daily: Structure; weekly: Structure } {
  const daily = dailyBars(minutes);
  const weekly = weeklyBars(daily);
  return { daily: classifyStructure(daily), weekly: classifyStructure(weekly) };
}
