/* Unit tests for the ladder tracker's pure transition (lib/runnerTracker.ts):
 * the live CHANGE decisions must match the backtest ladder (runner.ts). */
import { test } from "node:test";
import assert from "node:assert";
import { nextRungAction, type RunnerState } from "../lib/runnerTracker";

const state = (over: Partial<RunnerState> = {}): RunnerState => ({
  id: "t1",
  bankOrderId: "t1-bank",
  runnerOrderId: "t1-run",
  dir: 1,
  entry: 100,
  stop0: 98,
  risk: 2,
  contracts: 9,
  runnerQty: 3,
  lockedRungs: 0,
  entryTimeET: "02:00 NY",
  createdAt: new Date().toISOString(),
  ...over,
});

test("fresh runner: no move below 1R, BE at 1R, +1R lock at 2R, +2R lock at 3R", () => {
  assert.equal(nextRungAction(state(), 101, 99).move, "none");
  const be = nextRungAction(state(), 102.5, 101);
  assert.deepEqual(be, { move: "stop", rung: 1, stopPrice: 100 });
  const one = nextRungAction(state(), 104.5, 101);
  assert.deepEqual(one, { move: "stop", rung: 2, stopPrice: 102 });
  const two = nextRungAction(state(), 106.5, 103);
  assert.deepEqual(two, { move: "stop", rung: 3, stopPrice: 104 });
});

test("rungs never move the stop back down (already-locked state)", () => {
  const s = state({ lockedRungs: 2 }); // stop already at +1R (102)
  assert.equal(nextRungAction(s, 103, 102.1).move, "none"); // rung 1 < 2, no move
  const three = nextRungAction(s, 106, 103.5); // rung 3 → +2R
  assert.deepEqual(three, { move: "stop", rung: 3, stopPrice: 104 });
});

test("stop touch marks the runner done (exchange stop already fired)", () => {
  assert.equal(nextRungAction(state(), 101, 97.9).move, "done");
  // BE-locked runner stopped out at breakeven
  assert.equal(nextRungAction(state({ lockedRungs: 1 }), 101, 99.9).move, "done");
});

test("time exit: entryBarAge at the maxBars cap marks done", () => {
  assert.equal(nextRungAction(state(), 101, 99, 60, 59).move, "none");
  assert.equal(nextRungAction(state(), 101, 99, 60, 60).move, "done");
});

test("short mirror: rungs below entry, stops move down", () => {
  const s = state({ dir: -1, entry: 100, stop0: 102, risk: 2 });
  const be = nextRungAction(s, 99.5, 97.5);
  assert.deepEqual(be, { move: "stop", rung: 1, stopPrice: 100 });
  const two = nextRungAction(s, 99, 95.5); // fav 4.5 → rung 2
  assert.deepEqual(two, { move: "stop", rung: 2, stopPrice: 98 });
  const beLocked = state({ dir: -1, entry: 100, stop0: 102, risk: 2, lockedRungs: 1 });
  assert.equal(nextRungAction(beLocked, 100.5, 99).move, "done"); // BE stop touched
});

import { timeExitDue } from "../lib/runnerTracker";

test("timeExitDue: alerts once at 60 bars, then the runner keeps trailing", () => {
  assert.equal(timeExitDue({}, 59), false);
  assert.equal(timeExitDue({}, 60), true);
  assert.equal(timeExitDue({ timeExitAlertedAt: "2026-10-26T15:00:00Z" }, 75), false);
  assert.equal(timeExitDue({}, -1), false);
});
