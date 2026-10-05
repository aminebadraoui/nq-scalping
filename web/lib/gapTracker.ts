/* ------------------------------------------------------------------ *
 * Gap inventory + per-signal gap chips — journal-only context.
 *
 * Richie Naso (Words of Rizdom, 2024-12): "algorithms love to come back
 * to gaps… most of the time 50% of that gap is filled, if not all of
 * it." He trades the tape gap directly (bought the NQ pre-market puke
 * gap on fill). This module makes the claim measurable on our data:
 *
 *   gap  = a bar whose range does NOT overlap the prior bar's range
 *          (low > prior high → gap up; high < prior low → gap down).
 *          High/low only — no opens/closes required, so it works
 *          identically on the live feed and the session archive.
 *   fill = share of the gap zone re-traded by any later bar's range.
 *          Naso's own threshold is 50% ("half the gap gets filled"),
 *          so filledHalf uses fillPct ≥ 0.5 and filledFull = 1.0.
 *
 * Everything here is LABELS/FEATURES ONLY — nothing votes, gates, or
 * blocks (same contract as esJoin.ts / seasonal.ts). The falsification
 * study over the archive: scripts/gapProximityStudy.ts.
 *
 * Pure functions of the bar array; unit-tested, replayable.
 * ------------------------------------------------------------------ */

export type GapBar = { t: string; high: number; low: number };

export type Gap = {
  /** index of the bar AFTER the gap (the gap sits between idx−1 and idx) */
  idx: number;
  t: string;
  dir: "up" | "down";
  /** zone top (pts) */
  top: number;
  /** zone bottom (pts) */
  bottom: number;
  /** top − bottom (pts) */
  size: number;
  /** 0..1 — share of the zone re-traded by later bars */
  fillPct: number;
  /** ≥50% re-traded — Naso's own threshold */
  filledHalf: boolean;
  /** fully re-traded */
  filledFull: boolean;
};

/** minimum gap size to record (one NQ tick) — kills float noise */
export const MIN_GAP_PTS = 0.25;
/** Naso's fill threshold */
export const FILL_HALF = 0.5;
/** "recently filled" lookback in bars (30 min) */
export const RECENT_BARS = 30;

/** scan bars for non-overlapping-range gaps and their fill progress.
 *  Pure; O(gaps × bars) worst case — gaps per session are few, and the
 *  live loop recomputes once per check on a single session's bars. */
export function gapInventory(bars: GapBar[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (!Number.isFinite(prev.high) || !Number.isFinite(prev.low)) continue;
    if (!Number.isFinite(cur.high) || !Number.isFinite(cur.low)) continue;
    let dir: "up" | "down" | null = null;
    let bottom = 0;
    let top = 0;
    if (cur.low > prev.high) {
      dir = "up";
      bottom = prev.high;
      top = cur.low;
    } else if (cur.high < prev.low) {
      dir = "down";
      bottom = cur.high;
      top = prev.low;
    }
    if (!dir || top - bottom < MIN_GAP_PTS) continue;
    gaps.push({ idx: i, t: cur.t, dir, top, bottom, size: top - bottom, fillPct: 0, filledHalf: false, filledFull: false });
  }

  // fill tracking: merge the zone coverage of every later bar's range
  for (const g of gaps) {
    const ints: [number, number][] = [];
    for (let j = g.idx + 1; j < bars.length; j++) {
      const b = bars[j];
      const lo = Math.max(g.bottom, b.low);
      const hi = Math.min(g.top, b.high);
      if (hi > lo) ints.push([lo, hi]);
    }
    ints.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cur: [number, number] | null = null;
    for (const [a, b] of ints) {
      if (!cur) cur = [a, b];
      else if (a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else {
        covered += cur[1] - cur[0];
        cur = [a, b];
      }
    }
    if (cur) covered += cur[1] - cur[0];
    g.fillPct = g.size > 0 ? Math.min(1, covered / g.size) : 0;
    g.filledHalf = g.fillPct >= FILL_HALF;
    g.filledFull = g.fillPct >= 1 - 1e-9;
  }
  return gaps;
}

export type GapChips = {
  labels: string[];
  features: {
    /** gaps recorded so far this session (≥1 tick) */
    sessionGaps?: number;
    /** an unfilled gap (<50%) lies strictly inside the entry→target path */
    gapInPath?: boolean;
    /** pts from entry to the near edge of the nearest unfilled gap on the
     *  trade side (null when none) */
    nearestUnfilledGap?: number | null;
    /** pts from entry to the near edge of the in-path gap (null when none) */
    gapInPathPts?: number | null;
    /** a gap reached ≥50% fill within the last 30 bars — "gap-fill regime" */
    recentGapFill?: boolean;
  };
};

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The gap chips for a card. s = entry/target/dir; `bars` is the session
 *  minute array up to (and including) the signal bar. Pass the precomputed
 *  `gaps` when the caller already built the inventory (the live feed
 *  recomputes it once per check and reuses it across signals). */
export function gapChips(
  bars: GapBar[],
  s: { entry: number; target: number; dir: "long" | "short" },
  gaps: Gap[] = gapInventory(bars),
): GapChips {
  const labels: string[] = [];
  const features: GapChips["features"] = {};
  features.sessionGaps = gaps.length;
  if (!(Number.isFinite(s.entry) && Number.isFinite(s.target) && s.entry > 0 && s.target > 0)) {
    return { labels, features };
  }

  const long = s.dir === "long";
  const unfilled = gaps.filter((g) => !g.filledHalf);

  // in-path gap: the unfilled zone INTERSECTS the open profit path
  // (entry, target) — entry sitting inside the zone counts at distance 0.
  let inPathPts: number | null = null;
  for (const g of unfilled) {
    const inside = long ? g.top > s.entry && g.bottom < s.target : g.bottom < s.entry && g.top > s.target;
    if (!inside) continue;
    const dist = long ? Math.max(0, g.bottom - s.entry) : Math.max(0, s.entry - g.top);
    if (inPathPts === null || dist < inPathPts) inPathPts = dist;
  }
  if (inPathPts !== null) {
    features.gapInPath = true;
    features.gapInPathPts = r2(inPathPts);
    labels.push("GAP IN PATH");
  }

  // nearest unfilled gap the trade has to pass through (any distance;
  // 0 = entry already inside an unfilled zone)
  let nearest: number | null = null;
  for (const g of unfilled) {
    const onSide = long ? g.top > s.entry : g.bottom < s.entry;
    if (!onSide) continue;
    const dist = long ? Math.max(0, g.bottom - s.entry) : Math.max(0, s.entry - g.top);
    if (nearest === null || dist < nearest) nearest = dist;
  }
  features.nearestUnfilledGap = nearest === null ? null : r2(nearest);

  // gap-fill regime: something half-filled within the last 30 bars
  const recent = gaps.some((g) => g.filledHalf && g.idx >= bars.length - RECENT_BARS);
  if (recent) {
    features.recentGapFill = true;
    labels.push("GAP FILLED 30m");
  }

  return { labels, features };
}
