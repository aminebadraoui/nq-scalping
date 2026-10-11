/* ------------------------------------------------------------------ *
 * Challenge rules — the ONE definition of the MyFundedFutures
 * Rapid EOD 50k challenge, per stage.
 *
 * Why this exists (2026-10-11): the firm's numbers were re-stated in
 * ~7 places (accountGuard seeds, guardCore fallbacks, propAccount sim,
 * apPlan doc block, capacityTable, prop_sim.py, PLAYBOOK prose) and two
 * consumers had drifted (capacityTable's funded target; propAccount's
 * $100 lock applied to eval). This module is the single source:
 *
 *   · every numeric value derives from RAPID_EOD_50K (lib/propRules.ts)
 *   · the STAGE differences are expressed exactly once:
 *       eval    — starts at $50,000 nominal, target +$3,000, 30%
 *                 consistency ($900/day cap), min 4 days, floor trails
 *                 forever (no lock)
 *       funded  — starts at $0, the floor locks at $100 once reached,
 *                 no consistency cap, first payout at the $2,100 buffer,
 *                 then one per +$500, 90/10 split
 *   · the funded trading-halt target is profitTarget (+$3,000 from $0)
 *     — the same value the LIVE guard has always used (accountGuard.ts
 *     guardCheck). The $2,100 buffer is a PAYOUT threshold, not a
 *     trading halt.
 *
 * NOTE (flagged for owner confirmation against MFF's current terms):
 * PLAYBOOK.md's line "the EVAL floor locks at the starting balance"
 * matches NO code path (live eval trails forever); propAccount.ts
 * (simulateAccount) locks the floor at $100 for BOTH stages and should
 * gate that on stage === "funded" when its WIP is committed.
 *
 * Pure + client-safe. Unit-tested in tests/challengeRules.test.ts.
 * gcdata/prop_sim.py mirrors these values — change both together.
 * ------------------------------------------------------------------ */

import { RAPID_EOD_50K } from "../propRules";
import type { GuardStage } from "./guardCore";

export type ChallengeRules = {
  stage: GuardStage;
  /** normalized starting balance (eval $50,000 nominal / funded $0) */
  startBalance: number;
  /** the trading halt target, measured from the starting balance */
  profitTarget: number;
  /** EOD-trailing max-loss distance */
  maxLoss: number;
  /** eval-only daily profit cap (30% of target); null = no cap */
  consistencyCap: number | null;
  /** minimum trading days for the eval pass */
  minDays: number;
  /** funded-only floor lock; null = floor trails forever */
  lockAt: number | null;
  /** funded first-payout buffer */
  buffer: number;
  /** profit per subsequent payout unlock */
  payoutStep: number;
  /** trader share */
  split: number;
  /** plan contract cap */
  maxMicro: number;
  /** $ per 1.0 index point (MNQ) */
  pointValue: number;
};

export const EVAL_RULES: ChallengeRules = {
  stage: "eval",
  startBalance: 50_000,
  profitTarget: RAPID_EOD_50K.profitTarget,
  maxLoss: RAPID_EOD_50K.maxLoss,
  consistencyCap: Math.round(RAPID_EOD_50K.profitTarget * RAPID_EOD_50K.consistency),
  minDays: RAPID_EOD_50K.minDays,
  lockAt: null, // the live guard has never locked the eval floor (accountGuard.ts maybeCommitEod)
  buffer: RAPID_EOD_50K.buffer,
  payoutStep: RAPID_EOD_50K.payoutStep,
  split: RAPID_EOD_50K.split,
  maxMicro: RAPID_EOD_50K.maxMicro,
  pointValue: RAPID_EOD_50K.pointValue,
};

export const FUNDED_RULES: ChallengeRules = {
  stage: "funded",
  startBalance: 0,
  profitTarget: RAPID_EOD_50K.profitTarget, // +$3,000 from $0 — the live halt-target (payouts are separate)
  maxLoss: RAPID_EOD_50K.maxLoss,
  consistencyCap: null,
  minDays: 1,
  lockAt: 100,
  buffer: RAPID_EOD_50K.buffer,
  payoutStep: RAPID_EOD_50K.payoutStep,
  split: RAPID_EOD_50K.split,
  maxMicro: RAPID_EOD_50K.maxMicro,
  pointValue: RAPID_EOD_50K.pointValue,
};

export const rulesForStage = (stage: GuardStage): ChallengeRules =>
  stage === "funded" ? FUNDED_RULES : EVAL_RULES;
