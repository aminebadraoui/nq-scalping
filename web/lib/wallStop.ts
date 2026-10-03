/* ------------------------------------------------------------------ *
 * Wall-aware stops — Pulcini's stop-placement rule.
 *
 * "If I see a major GEX level right above where my stop is, why do I want
 * to stop out knowing there's going to be dealers hedging in that area?
 * So I'll put my stop above there."
 *
 * For a LONG the adverse direction is down: the relevant magnet is the
 * PUT wall (dealer support) BELOW the stop. If the wall sits within
 * `nearPts` beyond the stop, the stop moves to the far side of the wall
 * (wall − pad) so a wall-touch cannot stop the trade out. For a SHORT
 * the mirror: the CALL wall above the stop.
 *
 * The stop is only ever WIDENED, never tightened, and the target is
 * untouched (the wall is about not dying at the magnet, not about a new
 * plan). Pure function — unit-tested, wireable into the feed.
 * ------------------------------------------------------------------ */

import type { WallLevel } from "./options";

export type WallStopConfig = {
  /** the wall must sit within this many pts beyond the stop (adverse side) */
  nearPts: number;
  /** new stop = wall ∓ pad (the far side of the wall) */
  pad: number;
};

export const WALL_STOP_DEFAULTS: WallStopConfig = {
  nearPts: 10,
  pad: 0.5,
};

export type WallStopResult = {
  stop: number;
  widened: boolean;
  wall: WallLevel | null;
  /** the one-line note for the card ("stop beyond the put wall") */
  note: string;
};

/**
 * @param s   the signal: dir, current stop, entry
 * @param walls  dealer walls in NQ points (put = support, call = resistance)
 */
export function applyWallStop(
  s: { dir: "long" | "short"; stop: number; entry: number },
  walls: WallLevel[],
  cfg: WallStopConfig = WALL_STOP_DEFAULTS,
): WallStopResult {
  const kind = s.dir === "long" ? "put" : "call";
  let best: WallLevel | null = null;
  let bestStop = s.stop;

  for (const w of walls) {
    if (w.kind !== kind) continue;
    if (!Number.isFinite(w.p)) continue;
    const beyondStop = s.dir === "long" ? w.p < s.stop : w.p > s.stop;
    if (!beyondStop) continue;
    const dist = Math.abs(w.p - s.stop);
    if (dist > cfg.nearPts) continue;
    const candidate = s.dir === "long" ? w.p - cfg.pad : w.p + cfg.pad;
    const further = s.dir === "long" ? candidate < bestStop : candidate > bestStop;
    if (further) {
      best = w;
      bestStop = candidate;
    }
  }

  if (best) {
    return {
      stop: bestStop,
      widened: true,
      wall: best,
      note: `stop widened ${s.stop.toFixed(2)} → ${bestStop.toFixed(2)} (${best.kind} wall ${best.p.toFixed(2)} ∓ ${cfg.pad})`,
    };
  }
  return { stop: s.stop, widened: false, wall: null, note: "" };
}
