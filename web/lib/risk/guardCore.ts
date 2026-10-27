/* ------------------------------------------------------------------ *
 * Guard core — the ONE implementation of the day-plan guard rules.
 *
 * Architecture review 2026-10-11 P1 (docs/architecture/ARCHITECTURE-REVIEW.md):
 * the live guard (lib/accountGuard.ts guardCheck) and the backtest replay
 * (lib/guardReplay.ts) previously held two copies of the same rules with a
 * "change both the same day" comment. This module is the single home for:
 *
 *   · the config shape + the env reads (GuardConfig / guardConfigFromEnv)
 *   · every rule as a PURE predicate (no I/O, no env, no state)
 *
 * Live = these predicates + I/O (snapshot, persistence); replay = the same
 * predicates + replayed trade rows. The sequencing (in which order rules
 * are asked) remains each consumer's job and is documented there — the
 * RULES can no longer drift.
 *
 * Semantics are the live guardCheck semantics, including the "0 = off"
 * conventions (DAILY_LOSS_FLOOR, PROFIT_ARM, GUARD_GIVEBACK_PCT,
 * DD_HALF_AT) — the replay previously lacked those off-switches.
 * Unit-tested in tests/guardCore.test.ts + the existing guardReplay tests.
 * ------------------------------------------------------------------ */

import { RAPID_EOD_50K } from "../propRules";

export type GuardStage = "eval" | "funded";

/** Every knob the guard rules read. Fallbacks are the live defaults;
 *  `startBalance`/`eodHour` are live-only extras (replay normalizes
 *  equity to $0 and has no clock). */
export type GuardConfig = {
  /** day P&L at/below −dailyFloor halts new entries for the day (0 = off) */
  dailyFloor: number;
  /** day P&L at/above profitArm arms the one-more-trade rule (0 = off) */
  profitArm: number;
  /** give-back: halt once day P&L gives back givebackPct × dayPeak (0 = off) */
  givebackPct: number;
  /** give-back floor: below this dayPeak the protection is dormant */
  givebackFloor: number;
  /** consistency cap: 30% of the profit target — applies on EVERY stage
   *  (2026-10-11 owner decision: eval and funded trade under the same rules) */
  consistencyCap: number;
  /** halt new entries once equity is within guardMargin of the floor */
  guardMargin: number;
  /** drawdown at/above which sizing halves (0 = off) */
  ddHi: number;
  /** drawdown at/below which sizing restores (hysteresis) */
  ddLo: number;
  /** sizing multiplier while halved */
  ddMult: number;
  /** profit target measured from the starting balance */
  target: number;
  /** max loss limit (the trailing floor distance) */
  maxLoss: number;
  /** funded stage: the floor locks here once reached */
  lockAt: number;
  /** live-only: the normalized starting balance (eval $50k / funded $0) */
  startBalance?: number;
  /** live-only: the New York EOD close hour */
  eodHour?: number;
};

/** the live defaults — every key mirrors the env knobs both consumers read.
 *  Reading is done ONCE here; the two state machines consume the result. */
export function guardConfigFromEnv(env: Record<string, string | undefined> = process.env): GuardConfig {
  const num = (key: string, fallback: number): number => {
    // blank = unset: Number("") is 0, which silently DISABLED the daily
    // floor / consistency cap and zeroed the guard margin
    const raw = (env[key] ?? "").trim();
    if (raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    dailyFloor: num("DAILY_LOSS_FLOOR", 250),
    profitArm: num("PROFIT_ARM", 400),
    givebackPct: num("GUARD_GIVEBACK_PCT", 0.5),
    givebackFloor: num("GUARD_GIVEBACK_FLOOR", 250),
    consistencyCap: num("MFF_CONSISTENCY_CAP", Math.round(RAPID_EOD_50K.profitTarget * RAPID_EOD_50K.consistency)),
    guardMargin: num("MFF_GUARD_MARGIN", 500),
    ddHi: num("DD_HALF_AT", 600),
    ddLo: num("DD_FULL_AT", 300),
    ddMult: num("DD_HALF_MULT", 0.5),
    target: num("MFF_PROFIT_TARGET", RAPID_EOD_50K.profitTarget),
    maxLoss: num("MFF_MAX_LOSS", RAPID_EOD_50K.maxLoss),
    lockAt: num("MFF_LOCK_AT", 100),
    startBalance: Number.isFinite(Number(env.MFF_START_BALANCE)) ? Number(env.MFF_START_BALANCE) : undefined,
    eodHour: num("MFF_EOD_HOUR", 17),
  };
}

/* ---------------- the rules (pure) ---------------- */

/** profit target: pnlFromStart = equity − startBalance reaches the target */
export function targetReached(pnlFromStart: number, target: number): boolean {
  return pnlFromStart >= target;
}

/** eval target with the SOFT 30% consistency bar (2026-10-12 OOS find):
 *  a best day above the consistency share never FAILS the eval — it
 *  raises the effective target to bestDay ÷ share. The live target halt
 *  must respect the raised bar, otherwise the account freezes below it
 *  (OOS replay: +$3,022 with a $985 best day → bar $3,283 → flat target
 *  halt would strand the eval at "no-pass" forever). Funded has no
 *  consistency gate — callers apply this eval-only. */
export function raisedEvalTarget(profitTarget: number, bestDayPnl: number, consistencyCap: number): number {
  if (!(profitTarget > 0) || !(consistencyCap > 0)) return profitTarget;
  const share = consistencyCap / profitTarget;
  if (!(share > 0) || !(share < 1)) return profitTarget;
  return Math.max(profitTarget, bestDayPnl / share);
}

/** EOD floor margin: never let a new trade risk crossing the floor */
export function floorMarginHalts(equity: number, floor: number, margin: number): boolean {
  return equity <= floor + margin;
}

/** consistency cap (+$900/day): the same rule applies on EVERY stage
 *  (2026-10-11 owner decision — eval and funded trade under the same
 *  rules; the cap also forces ≥4 days to the +$3,000 target). 0 = off. */
export function consistencyHalts(dayPnl: number, cap: number): boolean {
  return cap > 0 && dayPnl >= cap;
}

/** daily loss floor: 0 = off (the live convention) */
export function dailyFloorHalts(dayPnl: number, dailyFloor: number): boolean {
  return dailyFloor > 0 && dayPnl <= -dailyFloor;
}

export type ProfitArmStep = { armed: boolean; halt: boolean; lastDayPnl: number | null };

/** profit arm: once day P&L crosses the arm, the FIRST drop ends the day.
 *  0 = off. When off, state is untouched (mirrors guardCheck exactly). */
export function profitArmStep(armed: boolean, lastDayPnl: number | null, dayPnl: number, arm: number): ProfitArmStep {
  if (!(arm > 0)) return { armed, halt: false, lastDayPnl };
  let next = armed;
  if (!next && dayPnl >= arm) next = true;
  const halt = next && lastDayPnl !== null && dayPnl < lastDayPnl;
  return { armed: next, halt, lastDayPnl: dayPnl };
}

export type GivebackStep = { halt: boolean; limit: number; dayPeak: number };

/** give-back protection: halt once day P&L gives back more than
 *  max(floor, pct × dayPeak) from the day's peak. 0 pct = off. */
export function givebackStep(dayPeak: number, dayPnl: number, pct: number, floor: number): GivebackStep {
  const peak = Math.max(dayPeak, dayPnl);
  if (!(pct > 0) || peak <= floor) return { halt: false, limit: floor, dayPeak: peak };
  const limit = Math.max(floor, pct * peak);
  return { halt: dayPnl <= peak - limit, limit, dayPeak: peak };
}

/** dd600→half hysteresis: arm at dd ≥ hi, restore at dd ≤ lo. hi ≤ 0 = off. */
export function ddHalfStep(halved: boolean, dd: number, hi: number, lo: number): boolean {
  if (!(hi > 0)) return halved;
  if (!halved && dd >= hi) return true;
  if (halved && dd <= lo) return false;
  return halved;
}

export type EodFloor = { floor: number; locked: boolean };

/** EOD floor trail: floor = equity − maxLoss, trailing UP only; funded
 *  locks at lockAt once reached and never moves after. */
export function eodFloorTrail(
  stage: GuardStage,
  locked: boolean,
  floor: number,
  equity: number,
  maxLoss: number,
  lockAt: number,
): EodFloor {
  const candidate = equity - maxLoss;
  if (stage === "funded" && !locked) {
    if (candidate >= lockAt) return { floor: lockAt, locked: true };
    return { floor: Math.max(floor, candidate), locked };
  }
  if (stage === "eval") return { floor: Math.max(floor, candidate), locked };
  return { floor, locked };
}
