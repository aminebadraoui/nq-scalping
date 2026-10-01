/* Strategy stats regression tests: the win-rate numbers on the Telegram
 * cards must match the measured baselines in PLAYBOOK.md — if one of these
 * changes without a new measurement, this test is the tripwire. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATS, headsUpWrLine } from "../lib/strategyStats.ts";

test("every strategy has a name and a stat line", () => {
  for (const key of Object.keys(STATS)) {
    assert.ok(STATS[key].name, `${key} has a name`);
    assert.ok(STATS[key].stat, `${key} has a stat line`);
  }
});

test("stat lines match the PLAYBOOK.md baselines", () => {
  assert.equal(STATS.momentum.stat, "WR 77.5% · PF 2.98 · 4,822 replay trades");
  assert.equal(STATS.momentum.aPlus, "78.9% WR");
  assert.equal(STATS.momentum.firstOfDay, "77.2% WR · PF 3.15");
  assert.equal(STATS.rth.stat, "WR 82.2% · PF 3.47 · 10,325 replay trades");
  assert.equal(STATS.rth.aPlus, "80.1% WR · PF 3.07");
  assert.equal(STATS.openDrive.stat, "93% hit @ TP15/SL35 · 87% of days");
  assert.equal(STATS.openPullback.stat, "69.8% WR · +5.2 pts net · 440 trades");
  assert.equal(STATS.openSniper.stat, "55.8% WR · +6.5 pts net (longs)");
  assert.equal(STATS.reversal.stat, "37% win · PF 2.16 · 683 sessions");
  assert.equal(STATS.sweepReclaim.stat, "67% lab win @ 1R");
});

test("heads-up summary lists every active strategy with its win rate", () => {
  const line = headsUpWrLine();
  assert.match(line, /WR: momentum 77\.5% · RTH 82\.2% · drive 93% · pullback 69\.8% · sniper 55\.8%/);
});
