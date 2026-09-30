/* Unit tests grounding sizing in the MyFundedFutures Rapid EOD 50k rules.
 *
 * Rule source (fetched 2026-09-30):
 *   https://help.myfundedfutures.com/en/articles/16158363-rapid-eod-50k-a-comprehensive-look
 *   · Profit target $3,000 · Max Loss Limit $2,000 (EOD trailing, locks at $100)
 *   · No daily loss limit · 3 mini / 30 micro max · 30% consistency (eval only)
 *   · 4 minimum trading days · $2,100 first-payout buffer · $500 payout steps
 *   · 90/10 split · MNQ = $2 per point */
import { test } from "node:test";
import assert from "node:assert";
import {
  RAPID_EOD_50K,
  momentumSize,
  PROP_RISK_PER_TRADE,
  contractsForRisk,
  estimateEval,
} from "../lib/propRules";

test("Rapid EOD 50k constants match the official plan rules", () => {
  assert.equal(RAPID_EOD_50K.profitTarget, 3000, "profit target $3,000");
  assert.equal(RAPID_EOD_50K.maxLoss, 2000, "max loss limit $2,000");
  assert.equal(RAPID_EOD_50K.consistency, 0.3, "30% consistency (eval only)");
  assert.equal(RAPID_EOD_50K.minDays, 4, "4 minimum trading days");
  assert.equal(RAPID_EOD_50K.maxMicro, 30, "30 micro / 3 mini contract cap");
  assert.equal(RAPID_EOD_50K.pointValue, 2, "MNQ $2 per point");
  assert.equal(RAPID_EOD_50K.buffer, 2100, "first-payout buffer $2,100");
  assert.equal(RAPID_EOD_50K.payoutStep, 500, "payout unlock step $500");
  assert.equal(RAPID_EOD_50K.split, 0.9, "90/10 split");
});

test("momentumSize: $170 budget at the median 3.5 pt momentum risk → 24 MNQ, $168 risk", () => {
  const s = momentumSize(3.5);
  assert.equal(s.contracts, 24); // floor(170 / (3.5 × $2)) = 24
  assert.equal(s.dollarRisk, 168);
  assert.equal(s.capped, false);
  assert.ok(s.dollarRisk <= PROP_RISK_PER_TRADE, "never exceeds the risk budget");
});

test("momentumSize: risk budget grounds every contract in $2 per point", () => {
  // $170 ÷ (2.0 pts × $2) = 42.5 raw → the 30-micro cap binds → 30 contracts, $120
  const s = momentumSize(2.0);
  assert.equal(s.contracts, RAPID_EOD_50K.maxMicro);
  assert.equal(s.dollarRisk, 120);
  assert.equal(s.capped, true);
  // and the per-contract math is exact: 30 × 2.0 pts × $2 = $120
  assert.equal(s.contracts * 2.0 * RAPID_EOD_50K.pointValue, s.dollarRisk);
});

test("momentumSize: caps at the plan's 30-micro contract limit", () => {
  const s = momentumSize(0.25); // $0.50 per contract → raw 340
  assert.equal(s.contracts, 30);
  assert.equal(s.capped, true);
  assert.equal(s.dollarRisk, 15);
});

test("momentumSize: floors at 1 contract even when the stop is wider than the budget", () => {
  const s = momentumSize(100); // $200/contract > $170 budget
  assert.equal(s.contracts, 1);
  assert.equal(s.dollarRisk, 200);
  assert.equal(s.capped, false);
});

test("ten consecutive full losses fit inside the $2,000 Max Loss Limit", () => {
  // EOD trailing MLL = $2,000, no daily loss limit: the risk budget must let a
  // realistic losing streak survive. 10 × $170 = $1,700 < $2,000 ✓
  const streakLoss = 10 * PROP_RISK_PER_TRADE;
  assert.ok(streakLoss <= RAPID_EOD_50K.maxLoss, `10-loss streak = $${streakLoss}`);
  // 11 losses = $1,870 still inside; 12 breaches — know where the line is
  assert.ok(11 * PROP_RISK_PER_TRADE <= RAPID_EOD_50K.maxLoss);
  assert.ok(12 * PROP_RISK_PER_TRADE > RAPID_EOD_50K.maxLoss);
});

test("contractsForRisk agrees with momentumSize (same $2/pt MNQ math)", () => {
  const c = contractsForRisk(170, 3.5);
  assert.equal(Math.floor(c), momentumSize(3.5).contracts);
});

test("estimateEval respects the 4 minimum trading days", () => {
  // the estimate uses the sweep-reclaim STRATEGY stats; the point here is the
  // eval-timeline math: daysToPass = max(minDays, target ÷ expected daily profit)
  const est = estimateEval(RAPID_EOD_50K, 170);
  assert.ok(est.contracts > 0);
  assert.ok(est.daysToPass >= RAPID_EOD_50K.minDays, `daysToPass ${est.daysToPass}`);
});
