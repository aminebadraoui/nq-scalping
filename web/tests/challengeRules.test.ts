/* Challenge-rules tests — pin the single per-stage definition and the
 * cross-module consistency: guardCore fallbacks, accountGuard seeds and
 * the capacity table all read the same numbers. */

import { test } from "node:test";
import assert from "node:assert";
import { EVAL_RULES, FUNDED_RULES, rulesForStage } from "../lib/risk/challengeRules";
import { guardConfigFromEnv, eodFloorTrail } from "../lib/risk/guardCore";
import { RAPID_EOD_50K } from "../lib/propRules";

test("every numeric value derives from RAPID_EOD_50K", () => {
  assert.equal(EVAL_RULES.profitTarget, RAPID_EOD_50K.profitTarget);
  assert.equal(EVAL_RULES.maxLoss, RAPID_EOD_50K.maxLoss);
  assert.equal(EVAL_RULES.consistencyCap, Math.round(RAPID_EOD_50K.profitTarget * RAPID_EOD_50K.consistency));
  assert.equal(EVAL_RULES.minDays, RAPID_EOD_50K.minDays);
  assert.equal(EVAL_RULES.buffer, RAPID_EOD_50K.buffer);
  assert.equal(EVAL_RULES.payoutStep, RAPID_EOD_50K.payoutStep);
  assert.equal(EVAL_RULES.split, RAPID_EOD_50K.split);
  assert.equal(FUNDED_RULES.maxLoss, RAPID_EOD_50K.maxLoss);
  assert.equal(FUNDED_RULES.buffer, RAPID_EOD_50K.buffer);
});

test("the trading rules are IDENTICAL across stages; only the start balance and the funded lock differ", () => {
  assert.equal(EVAL_RULES.startBalance, 50_000);
  assert.equal(FUNDED_RULES.startBalance, 0);
  assert.equal(EVAL_RULES.profitTarget, FUNDED_RULES.profitTarget, "same +$3,000 halt-target");
  assert.equal(EVAL_RULES.consistencyCap, 900);
  assert.equal(FUNDED_RULES.consistencyCap, 900, "the +$900/day cap applies on funded too");
  assert.equal(EVAL_RULES.lockAt, null, "eval floor trails forever (the live behavior)");
  assert.equal(FUNDED_RULES.lockAt, 100, "MFF funded floor-lock at $100 (the $2,100 buffer moment)");
  assert.equal(EVAL_RULES.minDays, 4);
});

test("guardCore fallbacks equal the challenge rules (no third set of numbers)", () => {
  const cfg = guardConfigFromEnv({});
  assert.equal(cfg.maxLoss, EVAL_RULES.maxLoss);
  assert.equal(cfg.target, EVAL_RULES.profitTarget);
  assert.equal(cfg.lockAt, FUNDED_RULES.lockAt);
  assert.equal(cfg.consistencyCap, EVAL_RULES.consistencyCap);
});

test("eodFloorTrail implements the per-stage lock from the rule table", () => {
  // eval: trails, never locks
  const ev = eodFloorTrail("eval", false, -2000, 5000, EVAL_RULES.maxLoss, FUNDED_RULES.lockAt!);
  assert.deepEqual(ev, { floor: 3000, locked: false });
  // funded: locks at $100 once equity − maxLoss ≥ 100 (the $2,100 buffer point)
  const fu = eodFloorTrail("funded", false, -2000, 2100, FUNDED_RULES.maxLoss, FUNDED_RULES.lockAt!);
  assert.deepEqual(fu, { floor: 100, locked: true });
});

test("rulesForStage picks the right table", () => {
  assert.equal(rulesForStage("eval"), EVAL_RULES);
  assert.equal(rulesForStage("funded"), FUNDED_RULES);
});
