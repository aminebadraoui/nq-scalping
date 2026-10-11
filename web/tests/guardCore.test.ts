/* Guard-core rule tests — pin the ONE implementation shared by the live
 * guard (lib/accountGuard.ts) and the replay (lib/guardReplay.ts).
 * Architecture review P1 (docs/architecture/ARCHITECTURE-REVIEW.md). */

import { test } from "node:test";
import assert from "node:assert";
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
} from "../lib/risk/guardCore";

test("targetReached: pnl-from-start vs target", () => {
  assert.equal(targetReached(3000, 3000), true);
  assert.equal(targetReached(2999, 3000), false);
});

test("floorMarginHalts", () => {
  assert.equal(floorMarginHalts(48_500, 48_000, 500), true, "equity exactly at floor + margin halts");
  assert.equal(floorMarginHalts(48_501, 48_000, 500), false, "just outside the margin");
});

test("consistencyHalts: the +$900/day cap applies on every stage; 0 = off", () => {
  assert.equal(consistencyHalts(900, 900), true);
  assert.equal(consistencyHalts(899, 900), false);
  assert.equal(consistencyHalts(900, 0), false, "0 = off");
});

test("dailyFloorHalts: 0 = off (the live convention, now shared with replay)", () => {
  assert.equal(dailyFloorHalts(-250, 250), true, "at the floor: halts");
  assert.equal(dailyFloorHalts(-249, 250), false);
  assert.equal(dailyFloorHalts(-500, 0), false, "0 = off");
});

test("profitArmStep: arms, then the first drop halts; 0 = off", () => {
  assert.deepEqual(profitArmStep(false, null, 200, 400), { armed: false, halt: false, lastDayPnl: 200 });
  assert.deepEqual(profitArmStep(false, 200, 400, 400), { armed: true, halt: false, lastDayPnl: 400 });
  assert.deepEqual(profitArmStep(true, 400, 500, 400), { armed: true, halt: false, lastDayPnl: 500 }, "win grants another");
  assert.deepEqual(profitArmStep(true, 500, 450, 400), { armed: true, halt: true, lastDayPnl: 450 }, "first loss after arming halts");
  const off = profitArmStep(false, 300, 350, 0);
  assert.equal(off.armed, false, "0 = off: never arms");
  assert.equal(off.halt, false);
  assert.equal(off.lastDayPnl, 300, "off: lastDayPnl untouched");
});

test("givebackStep: halts past max(floor, pct × peak); 0 pct = off", () => {
  const hit = givebackStep(600, 300, 0.5, 250);
  assert.equal(hit.halt, true, "gave back 300 = 0.5 × 600 peak");
  assert.equal(hit.dayPeak, 600);
  const edge = givebackStep(600, 350, 0.5, 250);
  assert.equal(edge.halt, false, "gave back 250 — at the limit, not past");
  const dormant = givebackStep(200, 0, 0.5, 250);
  assert.equal(dormant.halt, false, "peak below the floor: dormant");
  const off = givebackStep(600, 0, 0, 250);
  assert.equal(off.halt, false, "0 pct = off");
});

test("ddHalfStep: hysteresis + 0 = off", () => {
  assert.equal(ddHalfStep(false, 700, 600, 300), true, "dd ≥ hi: halve");
  assert.equal(ddHalfStep(true, 400, 600, 300), true, "between hi and lo: stay halved");
  assert.equal(ddHalfStep(true, 300, 600, 300), false, "dd ≤ lo: restore");
  assert.equal(ddHalfStep(false, 700, 0, 300), false, "hi = 0: off");
});

test("eodFloorTrail: eval trails; funded locks at lockAt", () => {
  assert.deepEqual(eodFloorTrail("eval", false, -2000, 500, 2000, 100), { floor: -1500, locked: false });
  assert.deepEqual(eodFloorTrail("eval", false, -1500, -100, 2000, 100), { floor: -1500, locked: false }, "trails UP only");
  assert.deepEqual(eodFloorTrail("funded", false, -2000, 2100, 2000, 100), { floor: 100, locked: true }, "funded locks at $100 once equity − maxLoss ≥ $100 (the $2,100 first-payout buffer)");
  assert.deepEqual(eodFloorTrail("funded", false, -2000, 100, 2000, 100), { floor: -1900, locked: false }, "below the buffer: still trailing");
  assert.deepEqual(eodFloorTrail("funded", true, 100, 1000, 2000, 100), { floor: 100, locked: true }, "locked: never moves");
});

test("guardConfigFromEnv reads every knob with the live fallbacks", () => {
  const cfg = guardConfigFromEnv({});
  assert.equal(cfg.dailyFloor, 250);
  assert.equal(cfg.profitArm, 400);
  assert.equal(cfg.givebackPct, 0.5);
  assert.equal(cfg.givebackFloor, 250);
  assert.equal(cfg.consistencyCap, 900);
  assert.equal(cfg.guardMargin, 500);
  assert.equal(cfg.ddHi, 600);
  assert.equal(cfg.ddLo, 300);
  assert.equal(cfg.ddMult, 0.5);
  assert.equal(cfg.target, 3000);
  assert.equal(cfg.maxLoss, 2000);
  assert.equal(cfg.lockAt, 100);
  assert.equal(cfg.eodHour, 17);
});
