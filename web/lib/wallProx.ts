/* ------------------------------------------------------------------ *
 * Wall/strike proximity — journal-only labels + features per card.
 *
 * Richie Naso (Words of Rizdom, 2024-12): deep-pocketed positions are
 * hedged with options, "these strike prices become huge, the algorithms
 * know where they're sitting and they're programmed to go to those
 * strike places." The project already computes the QQQ gamma walls
 * (lib/options.ts → OptionsRead in NQ points); this module turns them
 * into per-trade features so the claim becomes measurable.
 *
 * Forward-logging ONLY: the CBOE snapshot is daily and live-only, so
 * there is no historical wall archive to backtest against (same
 * limitation recorded in docs/research/wall-aware-stop-proxy-2026-10-03.md
 * — "re-test when historical gamma walls exist"). The features land in
 * signals.features jsonb on every card; when enough live signals have
 * accumulated, the strategy-insights layer (or a SQL bucketing script)
 * tests them. LABELS ONLY — nothing here votes, gates, or blocks.
 *
 * Pure function of an OptionsRead + the ticket prices; unit-tested.
 * ------------------------------------------------------------------ */

import { wallsFromRead, type OptionsRead } from "./options";

/** a wall counts as "near" inside this many pts (the mechanism's WALL_NEAR) */
export const WALL_NEAR_PTS = 20;

export type WallProxChips = {
  labels: string[];
  features: {
    /** the nearest relevant wall in the trade direction:
     *  long → call/flip above entry; short → put/flip below */
    wallAhead?: "call" | "put" | "flip" | null;
    /** pts from entry to that wall along the trade path (≥0, null = none) */
    wallDistPts?: number | null;
    /** the wall sits between entry and target — a magnet inside the profit path */
    wallInPath?: boolean;
    /** price has already traded through the relevant wall (the strike printed) */
    pastWall?: boolean;
  };
};

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The wall chips for a card. `read` = the options snapshot mapped to NQ
 *  points (null when the options feed has no snapshot — chips simply
 *  don't print, same degradation as the ES context). */
export function wallProxChips(
  read: OptionsRead | null,
  s: { entry: number; target: number; dir: "long" | "short" },
): WallProxChips {
  const labels: string[] = [];
  const features: WallProxChips["features"] = {};
  if (!read?.dataOk || !Number.isFinite(s.entry) || !Number.isFinite(s.target) || s.entry <= 0) {
    return { labels, features };
  }
  const long = s.dir === "long";
  const walls = wallsFromRead(read);

  // relevant walls on the trade side of entry: long → above, short → below
  const ahead = walls
    .filter((w) => Number.isFinite(w.p) && (long ? w.p > s.entry : w.p < s.entry))
    .sort((a, b) => Math.abs(a.p - s.entry) - Math.abs(b.p - s.entry));
  const w = ahead[0] ?? null;
  if (w) {
    features.wallAhead = w.kind;
    features.wallDistPts = r2(Math.abs(w.p - s.entry));
    features.wallInPath = long ? w.p <= s.target : w.p >= s.target;
    if (features.wallInPath) labels.push("WALL IN PATH");
    else if (features.wallDistPts !== undefined && features.wallDistPts <= WALL_NEAR_PTS) {
      labels.push(`WALL ${features.wallDistPts}PT`);
    }
  }

  // already through the directional wall: entry beyond the call wall (long)
  // or below the put wall (short) — the strike has printed. The flip is a
  // regime boundary, not a strike magnet, so it does not count here.
  const behindKind = long ? "call" : "put";
  const behind = walls.filter((x) => Number.isFinite(x.p) && x.kind === behindKind && (long ? x.p < s.entry : x.p > s.entry));
  if (behind.length > 0) {
    features.pastWall = true;
    labels.push("PAST WALL");
  }

  return { labels, features };
}
