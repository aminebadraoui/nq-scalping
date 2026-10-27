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
 * HONEST FILLS (2026-10-26, lib/honestFill.ts) — the default: the entry
 * is re-filled at the next bar's open (conservative p80 estimate + 0.25 slip) and
 * the initial stop keeps its distance from that fill; a rung (or the
 * bank) only counts when price trades one tick THROUGH it; stop exits
 * slip 0.25; time exits use the median-close estimate; the cost is at
 * least the MNQ commission per contract (0.95 pt). `fill: "legacy"`
 * reproduces the old close-fill numbers, which are not reachable live.
 *
 * Pure + client-safe, unit-tested (../tests/runner.test.mjs).
 * ------------------------------------------------------------------ */

import { closeEstimate, marketFillEstimate, DEFAULT_SLIP_PTS, MNQ_FEE_PTS, TICK, type FillBar } from "./honestFill";

type RunnerBar = { high: number; low: number; buy?: number; sell?: number; c?: number; o?: number };
type FillOpts = {
  fill?: "honest" | "legacy";
  slipPts?: number;
  /** "signal" (default): `entry` is the signal bar's close proxy — re-filled
   *  honestly. "fixed": `entry` is a real fill that happened inside bar
   *  entryIdx + 1 (a limit / retrace fill; callers pass fillIdx − 1) — kept,
   *  and that fill bar can stop the trade but never credits a rung/bank. */
  entryKind?: "signal" | "fixed";
};

/** honest re-fill of a signal-bar entry: returns the fill and the shifted stop */
function honestEntry(minutes: RunnerBar[], entryIdx: number, entry: number, stop0: number, dir: 1 | -1, slip: number): { entry: number; stop0: number } {
  const nb = minutes[entryIdx + 1];
  const sig = minutes[entryIdx] as FillBar;
  const open = nb && (nb.o ?? 0) > 0 ? (nb.o as number) : marketFillEstimate(sig, dir);
  const fill = open + dir * slip;
  return { entry: fill, stop0: stop0 + (fill - entry) };
}

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
  minutes: RunnerBar[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  opts: { maxBars?: number; cost?: number } & FillOpts = {},
): RunnerTrade | null {
  const maxBars = opts.maxBars ?? 60;
  const honest = (opts.fill ?? "honest") === "honest";
  const slip = honest ? (opts.slipPts ?? DEFAULT_SLIP_PTS) : 0;
  const tt = honest ? TICK : 0; // rung trade-through
  const cost = honest ? Math.max(opts.cost ?? 0, MNQ_FEE_PTS) : (opts.cost ?? 0.5);
  if (honest && opts.entryKind !== "fixed" && entryIdx + 1 < minutes.length) ({ entry, stop0 } = honestEntry(minutes, entryIdx, entry, stop0, dir, slip));
  const fixedFill = honest && opts.entryKind === "fixed";
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
    const rungHere = fav - tt > 0 ? Math.floor((fav - tt) / risk) : 0;

    // pessimistic house rule: the current stop is judged first
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      stopped = true;
      exit = stop - dir * slip;
      heldBars = j - entryIdx;
      if (j === start && rungHere >= 1) ambiguous = true;
      break;
    }
    // no stop: raise the ladder with whatever this bar's high reached
    // (never on a fixed fill's own bar — the order inside it is unknown)
    if (rungHere >= 1 && !(fixedFill && j === start)) {
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
    exit = honest ? closeEstimate(minutes[end] as FillBar) - dir * slip : (minutes[end].high + minutes[end].low) / 2;
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

/* ------------------------------------------------------------------ *
 * Scale-out variant: bank `bankR` on `bankUnits` of the position at
 * the first rung, then ladder the remaining `runnerUnits` (stop → BE
 * at the bank, then +1R per extra rung, exactly like scoreRunner).
 * Default 2 units banked at 1R + 1 unit running.
 * ------------------------------------------------------------------ */

export type ScaleOutTrade = {
  dir: 1 | -1;
  entryIdx: number;
  entry: number;
  stop0: number;
  risk: number;
  pnl: number; // points, cost included (house 0.5 pt trade-level cost)
  totalR: number; // sum of R across all units (e.g. 2 banked at 1R + runner 2R = 4)
  hit: "stop" | "time";
  heldBars: number;
  mfeR: number;
  maeR: number;
  fullLoss: boolean; // stopped out before the bank rung
  banked: boolean; // did the bank rung get hit
  runnerExitR: number; // the running unit's exit in R (0 = BE)
  ambiguous: boolean;
};

export function scoreScaleOut(
  minutes: RunnerBar[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  opts: { bankR?: number; bankUnits?: number; runnerUnits?: number; maxBars?: number; cost?: number } & FillOpts = {},
): ScaleOutTrade | null {
  const bankR = opts.bankR ?? 1;
  const bankUnits = opts.bankUnits ?? 2;
  const runnerUnits = opts.runnerUnits ?? 1;
  const units = bankUnits + runnerUnits;
  const maxBars = opts.maxBars ?? 60;
  const honest = (opts.fill ?? "honest") === "honest";
  const slip = honest ? (opts.slipPts ?? DEFAULT_SLIP_PTS) : 0;
  const tt = honest ? TICK : 0;
  // honest: the commission is per contract — every unit pays it
  const cost = honest ? Math.max(opts.cost ?? 0, MNQ_FEE_PTS * units) : (opts.cost ?? 0.5);
  if (honest && opts.entryKind !== "fixed" && entryIdx + 1 < minutes.length) ({ entry, stop0 } = honestEntry(minutes, entryIdx, entry, stop0, dir, slip));
  const fixedFill = honest && opts.entryKind === "fixed";
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0)) return null;

  let stop = stop0;
  let banked = false;
  let runnerExitR = -1; // full-loss default: the runner also took −1R
  let stopped = false;
  let heldBars = 0;
  let mfe = 0;
  let mae = 0;
  let ambiguous = false;

  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + maxBars);
  if (start > end) return null;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    const rung = fav - tt > 0 ? Math.floor((fav - tt) / risk) : 0;

    // 1) pessimistic: the current stop is judged first
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      stopped = true;
      runnerExitR = banked ? ((stop - dir * slip - entry) * dir) / risk : -1 - slip / risk;
      heldBars = j - entryIdx;
      if (j === start && rung >= bankR) ambiguous = true;
      break;
    }

    // a fixed fill's own bar can stop the trade but never banks/trails
    if (fixedFill && j === start) {
      heldBars = j - entryIdx;
      continue;
    }

    // 2) bank the first rung, move the runner to breakeven
    if (!banked && rung >= bankR) {
      banked = true;
      stop = entry;
      // pessimistic: if the same bar also traded back through BE, the
      // runner is out at breakeven before the bar closes
      if (dir > 0 ? b.low <= entry : b.high >= entry) {
        runnerExitR = 0;
        stopped = true;
        heldBars = j - entryIdx;
        break;
      }
    }

    // 3) trail the runner: at rung n the stop sits at (n−1)R
    if (banked && rung >= bankR + 1) {
      const newStop = entry + dir * (rung - 1) * risk;
      if (dir > 0 ? newStop > stop : newStop < stop) stop = newStop;
    }
    heldBars = j - entryIdx;
  }

  // never stopped → time exit at the final bar's close
  if (!stopped) {
    const close = honest ? closeEstimate(minutes[end] as FillBar) - dir * slip : (minutes[end].high + minutes[end].low) / 2;
    runnerExitR = ((close - entry) * dir) / risk;
    heldBars = end - entryIdx;
  }

  const totalR = banked ? bankR * bankUnits + runnerUnits * runnerExitR : units * runnerExitR;
  const pnl = totalR * risk - cost;
  return {
    dir,
    entryIdx,
    entry,
    stop0,
    risk,
    pnl,
    totalR,
    hit: stopped ? "stop" : "time",
    heldBars,
    mfeR: mfe,
    maeR: mae,
    fullLoss: !banked && stopped,
    banked,
    runnerExitR: runnerExitR === 0 ? 0 : runnerExitR,
    ambiguous,
  };
}
