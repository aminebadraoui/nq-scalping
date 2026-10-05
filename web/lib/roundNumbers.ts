/* ------------------------------------------------------------------ *
 * Round-number proximity — journal-only labels + features for every card.
 *
 * Richie Naso's tape-read thesis (Words of Rizdom podcast, 2024-12):
 * algorithms are "written by a programmer, and they have to be written
 * to go somewhere" — technical areas, gaps, option strikes and,
 * "especially 50", the 50-point handles (21,800 / 21,850 / …). His
 * specific stop-placement claim: stops parked AT the number get swept —
 * "don't put it at 50, you're going to get hit; put it at 40, give
 * yourself a chance to breathe."
 *
 * This module turns that into falsifiable per-trade features, logged on
 * every card exactly like the ES and seasonal chips. LABELS ONLY —
 * nothing here votes, gates, or blocks. The falsification study that
 * consumes these features over the archive: scripts/roundNumberStopStudy.ts.
 *
 * Pure functions of prices only; unit-tested, replayable.
 * ------------------------------------------------------------------ */

export const ROUND_STEP = 50; // pts — the "50-handle" granularity
export const AT_ROUND_PTS = 1.0; // pts — "parked on the number"

/** nearest multiple of `step` (ties round up, like Math.round) */
export function nearestRound(price: number, step = ROUND_STEP): number {
  return Math.round(price / step) * step;
}

/** SIGNED distance from price to its nearest handle (price − round):
 *  positive = above the nearest handle, negative = below. */
export function distToRound(price: number, step = ROUND_STEP): number {
  return price - nearestRound(price, step);
}

/** true when price sits within `tol` pts of a step-handle */
export function atRound(price: number, step = ROUND_STEP, tol = AT_ROUND_PTS): boolean {
  return Math.abs(distToRound(price, step)) <= tol;
}

/** true when a step-handle lies strictly between `a` and `b` (exclusive).
 *  The "target must cross a handle" test: for a long, entry < handle < target. */
export function roundBetween(a: number, b: number, step = ROUND_STEP): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (!(hi > lo)) return false;
  // the smallest multiple of step strictly greater than lo
  const first = (Math.floor(lo / step) + 1) * step;
  return first < hi;
}

export type RoundNumberChips = {
  labels: string[];
  features: {
    /** signed pts from entry to its nearest 50-handle (entry − handle) */
    entryToRound50?: number;
    /** signed pts from stop to its nearest 50-handle */
    stopToRound50?: number;
    /** signed pts from target to its nearest 50-handle */
    targetToRound50?: number;
    /** entry within 1 pt of a handle */
    entryAtRound?: boolean;
    /** stop parked within 1 pt of a handle — Naso's sweep-trap claim */
    stopAtRound?: boolean;
    /** a handle sits between entry and target — the "algos print the
     *  number" path test */
    targetCrossRound?: boolean;
  };
};

const r1 = (n: number): number => Math.round(n * 100) / 100;

/** The round-number chips for a card. s = entry/stop/target prices + dir.
 *  Labels are printed on the card, features land in signals.features
 *  jsonb — both journal-only. */
export function roundNumberChips(s: {
  entry: number;
  stop: number;
  target: number;
  dir: "long" | "short";
}): RoundNumberChips {
  const labels: string[] = [];
  const features: RoundNumberChips["features"] = {};
  if (![s.entry, s.stop, s.target].every((n) => Number.isFinite(n) && n > 0)) {
    return { labels, features };
  }

  features.entryToRound50 = r1(distToRound(s.entry));
  features.stopToRound50 = r1(distToRound(s.stop));
  features.targetToRound50 = r1(distToRound(s.target));
  // booleans set only when true (house style: esJoin.ts / seasonal.ts)
  if (atRound(s.entry)) features.entryAtRound = true;
  if (atRound(s.stop)) features.stopAtRound = true;
  if (roundBetween(s.entry, s.target)) features.targetCrossRound = true;

  if (features.stopAtRound) labels.push("STOP @ROUND");
  if (features.targetCrossRound) labels.push("TARGET CROSSES 50");
  else if (features.entryAtRound) labels.push("ENTRY @ROUND");
  return { labels, features };
}
