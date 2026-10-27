/* ------------------------------------------------------------------ *
 * Trade profiles — the optimized stop/target/time/size settings per
 * strategy family (docs/research/sizing-optimizer-2026-10-04.md for
 * momentum, rth-optimizer-2026-10-05.md for RTH). PURE — no I/O — so
 * the math is unit-testable and the feed applies it identically.
 *
 * OFF BY DEFAULT since the 2026-10-05 day-plan adoption (apPlan full-pool
 * study): the live plan trades the DETECTORS' structural stops and native
 * targets (momentum 1R, RTH 0.75R, open TP15/SL35) at the $100 budget.
 * Set MOM_PROFILE=1 / RTH_PROFILE=1 to re-enable a profile:
 *
 *   MOM_STOP_MULT (0.35) · MOM_TARGET_R (2.25)
 *   MOM_SIZE_MULT (1)   · MOM_TIME_EXIT_BARS (60)
 *   RTH_STOP_MULT (0.45) · RTH_TARGET_R (1.75)
 *   RTH_SIZE_MULT (1)   · RTH_TIME_EXIT_BARS (45)
 *
 * Stop/target semantics (identical to the backtest scorer): the stop
 * distance is stopMult × the signal's 1R risk, and the target sits
 * targetR × THAT distance from the entry — i.e. target distance =
 * stopMult × targetR × risk.
 *
 * Sizing: ×1 (the default) = the $100 per-trade risk budget at the
 * profile stop, 30-micro cap.
 * ------------------------------------------------------------------ */

import { momentumSize } from "./propRules";

export type FamilyProfile = {
  enabled: boolean;
  stopMult: number;
  targetR: number;
  sizeMult: number;
  timeExitBars: number;
};

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function momentumProfile(env: Record<string, string | undefined> = process.env): FamilyProfile {
  return {
    enabled: (env.MOM_PROFILE ?? "0") === "1",
    stopMult: num(env.MOM_STOP_MULT, 0.35),
    targetR: num(env.MOM_TARGET_R, 2.25),
    sizeMult: num(env.MOM_SIZE_MULT, 1),
    timeExitBars: Math.round(num(env.MOM_TIME_EXIT_BARS, 60)),
  };
}

export function rthProfile(env: Record<string, string | undefined> = process.env): FamilyProfile {
  return {
    enabled: (env.RTH_PROFILE ?? "0") === "1",
    stopMult: num(env.RTH_STOP_MULT, 0.45),
    targetR: num(env.RTH_TARGET_R, 1.75),
    sizeMult: num(env.RTH_SIZE_MULT, 1),
    timeExitBars: Math.round(num(env.RTH_TIME_EXIT_BARS, 45)),
  };
}

/** apply the profile to a signal's structural levels. Returns the
 *  exchange-side bracket prices (absolute). */
export function applyProfile(
  dir: "long" | "short",
  entry: number,
  risk: number,
  p: FamilyProfile,
): { stop: number; target: number; riskPts: number } {
  const sign = dir === "long" ? 1 : -1;
  const riskPts = risk * p.stopMult;
  return {
    stop: entry - sign * riskPts,
    target: entry + sign * riskPts * p.targetR,
    riskPts,
  };
}

/** contracts for a profile-sized trade (30-micro cap applies). */
export function profileContracts(
  risk: number,
  p: FamilyProfile,
  riskBudget: number,
  maxMicro = 30,
): number {
  const riskPts = risk * p.stopMult;
  return momentumSize(riskPts, riskBudget * p.sizeMult, { maxMicro, pointValue: 2 }).contracts;
}

/** the exit timestamp for a profile's time exit (bar ≈ minute). */
export function timeExitAt(nowMs: number, p: FamilyProfile): number {
  return nowMs + p.timeExitBars * 60_000;
}

/** pure decision helper (unit-tested): should the time exit fire?
 *  `dir` is the registered trade's side. The exit fires only when the
 *  open net position is on THAT side — a short is net-negative (before
 *  2026-10-26 only `held > 0` fired, so shorts never time-exited, and a
 *  short's exit could fire against an unrelated long and add to it). */
export function timeExitDecision(
  nowMs: number,
  exitAtMs: number,
  held: number | null,
  dir: "long" | "short" = "long",
): "fire" | "wait" | "hold" {
  if (nowMs < exitAtMs) return "wait";
  if (held === null) return "hold"; // unreadable book — keep the exit pending, never guess
  return (dir === "long" ? held > 0 : held < 0) ? "fire" : "hold";
}
