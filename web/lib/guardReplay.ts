/* ------------------------------------------------------------------ *
 * Guard replay — the LIVE day-plan guard stack, replayed trade by
 * trade for backtests. The RULES now live in lib/risk/guardCore.ts
 * (the single source shared with lib/accountGuard.ts — architecture
 * review P1, 2026-10-11); this module keeps the replay's own
 * SEQUENCING (entry-gate order, one-more-trade latch, EOD trailing)
 * and its stats, but no rule formula of its own.
 *
 * Sequencing note (deliberate): the entry gate asks the rules in the
 * order target → margin → consistency → loss → give-back, and the
 * profit-arm rule runs on the CLOSING trade (a drop after arming),
 * while the live guardCheck asks profit-arm and give-back between its
 * other checks. The rules themselves are identical — guardCore.ts is
 * the one place they change.
 *
 * News blackouts (funded T1) are NOT replayable from the archive and
 * stay out; operator overrides/ticket veto are live-only decisions.
 *
 * Pure + client-safe. Unit-tested in tests/guardReplay.test.ts and
 * tests/guardCore.test.ts.
 * ------------------------------------------------------------------ */

import type { DollarizedTrade } from "./propAccount";
import {
  guardConfigFromEnv,
  targetReached,
  floorMarginHalts,
  consistencyHalts,
  dailyFloorHalts,
  profitArmStep,
  givebackStep,
  ddHalfStep,
  eodFloorTrail,
  type GuardConfig,
  type GuardStage,
} from "./risk/guardCore";

export type { GuardConfig, GuardStage } from "./risk/guardCore";
export { guardConfigFromEnv } from "./risk/guardCore";

export type GuardStats = {
  worstDayUsd: number;
  maxDdUsd: number;
  longestRedDays: number;
  longestLoseStreak: number;
  /** Kelly stand-asides (0-contract rows) — no position, no state change */
  standAsides: number;
  halts: { loss: number; profit: number; giveback: number; consistency: number; margin: number; target: number };
  /** trades skipped because the day was already halted */
  skippedByHalt: number;
  /** trades actually taken (after halts, stand-asides and dd scaling) */
  traded: number;
};

/**
 * Replay the guard stack over dated, already-dollarized rows (flat or
 * Kelly — contracts are the base size). Rows must be chronological.
 * Returns the filtered, dd-scaled rows plus the guard diagnostics.
 */
export function guardReplay(
  rows: DollarizedTrade[],
  stage: GuardStage,
  cfg: GuardConfig = guardConfigFromEnv(),
): { rows: DollarizedTrade[]; stats: GuardStats } {
  const out: DollarizedTrade[] = [];
  const stats: GuardStats = {
    worstDayUsd: 0,
    maxDdUsd: 0,
    longestRedDays: 0,
    longestLoseStreak: 0,
    standAsides: 0,
    halts: { loss: 0, profit: 0, giveback: 0, consistency: 0, margin: 0, target: 0 },
    skippedByHalt: 0,
    traded: 0,
  };

  const byDay = new Map<string, DollarizedTrade[]>();
  for (const r of rows) {
    const d = byDay.get(r.date) ?? [];
    d.push(r);
    byDay.set(r.date, d);
  }
  const dates = [...byDay.keys()].sort();

  let equity = 0;
  let highWater = 0;
  let floor = -cfg.maxLoss;
  let locked = false;
  let ddHalved = false;
  let streak = 0;
  let redDays = 0;
  let peakEquity = 0;
  let targetHit = false;

  for (const date of dates) {
    let dayPnl = 0;
    let dayPeak = 0;
    let armed = false;
    let lastPnl: number | null = null;
    let dayHalted = false;

    for (const r of byDay.get(date)!) {
      // the day is over — every remaining card is skipped (one halt reason
      // is counted per day, the first one that fired)
      if (dayHalted) {
        stats.skippedByHalt++;
        continue;
      }
      // stand-aside rows (Kelly f ≤ 0): no position, no realized move,
      // no gate state — the live feed never fires these cards sized 0
      if (r.contracts === 0) {
        stats.standAsides++;
        continue;
      }

      // ---- the entry gate, in replay order (rules: guardCore.ts) ----
      let halt: keyof GuardStats["halts"] | null = null;
      if (targetHit || targetReached(equity, cfg.target)) {
        targetHit = true;
        halt = "target";
      } else if (floorMarginHalts(equity, floor, cfg.guardMargin)) {
        halt = "margin";
      } else if (consistencyHalts(stage, dayPnl, cfg.consistencyCap)) {
        halt = "consistency";
      } else if (dailyFloorHalts(dayPnl, cfg.dailyFloor)) {
        halt = "loss";
      } else {
        // the give-back reference moves at every check
        const gb = givebackStep(dayPeak, dayPnl, cfg.givebackPct, cfg.givebackFloor);
        dayPeak = gb.dayPeak;
        if (gb.halt) halt = "giveback";
      }
      if (halt) {
        stats.halts[halt]++;
        dayHalted = true;
        stats.skippedByHalt++;
        continue;
      }

      // ---- dd600→half sizing (hysteresis, challenge-wide) ----
      ddHalved = ddHalfStep(ddHalved, Math.max(0, highWater - equity), cfg.ddHi, cfg.ddLo);
      const mult = ddHalved ? cfg.ddMult : 1;
      const contracts = Math.max(1, Math.round(r.contracts * mult));
      const pnl = Math.round(r.pnlPts * 2 * contracts * 100) / 100;

      equity += pnl;
      dayPnl += pnl;

      // ---- the one-more-trade rule (closing-trade semantics) ----
      const pa = profitArmStep(armed, lastPnl, dayPnl, cfg.profitArm);
      armed = pa.armed;
      lastPnl = pa.lastDayPnl;
      if (pnl < 0) {
        streak++;
        stats.longestLoseStreak = Math.max(stats.longestLoseStreak, streak);
        // the documented one-more-trade rule (same as apPlan's runDay):
        // once armed, the first LOSING close ends the day
        if (pa.halt) {
          stats.halts.profit++;
          dayHalted = true;
        }
      } else {
        streak = 0;
      }
      out.push({ ...r, contracts, pnl });
      stats.traded++;
    }

    // ---- EOD: floor trails up at the close; funded locks at lockAt ----
    highWater = Math.max(highWater, equity);
    peakEquity = Math.max(peakEquity, equity);
    stats.maxDdUsd = Math.max(stats.maxDdUsd, peakEquity - equity);
    stats.worstDayUsd = Math.min(stats.worstDayUsd, dayPnl);
    if (dayPnl < 0) {
      redDays++;
      stats.longestRedDays = Math.max(stats.longestRedDays, redDays);
    } else {
      redDays = 0;
    }
    const trail = eodFloorTrail(stage, locked, floor, equity, cfg.maxLoss, cfg.lockAt);
    floor = trail.floor;
    locked = trail.locked;
  }

  return { rows: out, stats };
}
