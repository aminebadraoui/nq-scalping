/* ------------------------------------------------------------------ *
 * Runner exit engine — open target with a trailing rung ladder.
 *
 * The user's requested management, scored bar-by-bar:
 *   · entry at the trigger bar's close (as always)
 *   · NO fixed target — the trade is allowed to run
 *   · at +1R the stop moves to breakeven
 *   · at +2R the stop moves to +1R
 *   · at +3R the stop moves to +2R   (and so on, every R)
 *   · time exit after `maxBars` minutes at that bar's close
 *
 * Same house rules as the fixed-target scorer (scoreSignal in
 * momentumStudy.ts): per-bar pessimism — the current stop is checked
 * BEFORE any rung raise in the same bar; the entry+1 bar where the
 * initial stop AND the first rung are both touched is flagged
 * `ambiguous`. Costs are 0.5 pt round-trip.
 *
 * Pure + client-safe, unit-tested (web/tests/runner.test.mjs).
 * ------------------------------------------------------------------ */

export type RunnerTrade = {
  dir: 1 | -1;
  entryIdx: number;
  entry: number;
  stop0: number;
  risk: number;
  exit: number;
  pnl: number; // net points, cost included
  hit: "stop" | "time";
  heldBars: number;
  mfeR: number; // max favorable excursion, in R
  maeR: number; // max adverse excursion, in R
  maxFavorR: number; // highest rung level reached
  rungs: number; // number of rungs hit (1R, 2R, …)
  exitR: number; // (exit - entry) in R, cost excluded
  beTouched: boolean; // did the stop ever sit at/above breakeven
  ambiguous: boolean;
};

export function scoreRunner(
  minutes: { high: number; low: number }[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  opts: { maxBars?: number; cost?: number } = {},
): RunnerTrade | null {
  const maxBars = opts.maxBars ?? 60;
  const cost = opts.cost ?? 0.5;
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0)) return null;

  let stop = stop0;
  let exit = stop0;
  let hit: RunnerTrade["hit"] = "stop";
  let heldBars = 0;
  let mfe = 0;
  let mae = 0;
  let maxFavorR = 0;
  let rungs = 0;
  let beTouched = false;
  let ambiguous = false;
  let stopped = false;

  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + maxBars);
  if (start > end) return null;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    const rungHere = fav > 0 ? Math.floor(fav / risk) : 0;

    // pessimistic house rule: the current stop is judged first
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      stopped = true;
      exit = stop;
      heldBars = j - entryIdx;
      if (j === start && rungHere >= 1) ambiguous = true;
      break;
    }
    // no stop: raise the ladder with whatever this bar's high reached
    if (rungHere >= 1) {
      rungs = Math.max(rungs, rungHere);
      const newStop = entry + dir * (rungHere - 1) * risk;
      if (dir > 0 ? newStop > stop : newStop < stop) stop = newStop;
      beTouched = true;
      maxFavorR = Math.max(maxFavorR, rungHere);
    }
    heldBars = j - entryIdx;
  }

  // never stopped → time exit at the final bar's close
  if (!stopped) {
    hit = "time";
    exit = (minutes[end].high + minutes[end].low) / 2;
    heldBars = end - entryIdx;
  }

  const pnl = (exit - entry) * dir - cost;
  const exitR = ((exit - entry) * dir) / risk;
  return {
    dir,
    entryIdx,
    entry,
    stop0,
    risk,
    exit,
    pnl,
    hit,
    heldBars,
    mfeR: mfe,
    maeR: mae,
    maxFavorR,
    rungs,
    exitR: exitR === 0 ? 0 : exitR, // normalize -0
    beTouched,
    ambiguous,
  };
}
