/* Unit tests for the runner ladder engine (web/lib/runner.ts).
 * Run as part of `npm test` (node:test over web/tests/*.test.mjs).
 *
 * Fixture convention: minutes[0] is the ENTRY bar (its values are unused by
 * the engine — scoring starts at entryIdx+1); every row after it is a
 * post-entry minute. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRunner, scoreScaleOut } from "../lib/runner.ts";

const bars = (rows) => [[100, 100], ...rows].map(([high, low]) => ({ high, low }));
const LONG = { entry: 100, stop0: 98, dir: 1, entryIdx: 0 }; // risk 2

test("runner: BE stop after 1R rung", () => {
  const t = scoreRunner(
    bars([
      [101, 99], // no rung
      [102.5, 101], // rung 1 → stop 100
      [100.5, 99.5], // low ≤ 100 → BE out
    ]),
    LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx,
  );
  assert.equal(t.hit, "stop");
  assert.equal(t.exit, 100);
  assert.equal(t.exitR, 0);
  assert.equal(t.pnl, -0.5);
  assert.equal(t.rungs, 1);
  assert.ok(t.beTouched);
  assert.ok(!t.ambiguous);
});

test("runner: locks 1R after 2R rung", () => {
  const t = scoreRunner(
    bars([
      [104, 101], // rung 2 → stop 102
      [102.5, 101.5], // low ≤ 102 → out at +1R
    ]),
    LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx,
  );
  assert.equal(t.exit, 102);
  assert.equal(t.exitR, 1);
  assert.equal(t.pnl, 2 - 0.5);
  assert.equal(t.rungs, 2);
});

test("runner: locks 2R after 3R rung", () => {
  const t = scoreRunner(
    bars([
      [106, 103], // rung 3 → stop 104
      [105, 103.5], // low ≤ 104 → out at +2R
    ]),
    LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx,
  );
  assert.equal(t.exit, 104);
  assert.equal(t.exitR, 2);
  assert.equal(t.pnl, 4 - 0.5);
});

test("runner: initial stop untouched when no rung reached", () => {
  const t = scoreRunner(
    bars([
      [99.5, 97.9], // low ≤ 98 → full stop
    ]),
    LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx,
  );
  assert.equal(t.exit, 98);
  assert.equal(t.pnl, -2 - 0.5);
  assert.ok(!t.beTouched);
  assert.equal(t.rungs, 0);
});

test("runner: pessimistic same-bar on the entry+1 bar", () => {
  const t = scoreRunner(
    bars([[102.5, 97.5]]), // 1R AND initial stop in one bar → stop first
    LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx,
  );
  assert.equal(t.hit, "stop");
  assert.equal(t.exit, 98);
  assert.ok(t.ambiguous);
});

test("runner: time exit at final close when never stopped", () => {
  const rows = Array.from({ length: 60 }, () => [100.5, 99.5]).map(([high, low]) => ({ high, low }));
  const t = scoreRunner(rows, LONG.entry, LONG.stop0, LONG.dir, LONG.entryIdx);
  assert.equal(t.hit, "time");
  assert.equal(t.heldBars, 59); // 60 rows total, one is the entry bar
  assert.equal(t.exit, 100);
  assert.equal(t.pnl, -0.5);
});

test("runner: short mirror — BE after 1R down", () => {
  const t = scoreRunner(
    bars([
      [99, 97.5], // rung 1 → stop 100
      [100.5, 99.5], // high ≥ 100 → BE out
    ]),
    100, 102, -1, 0,
  );
  assert.equal(t.exit, 100);
  assert.equal(t.exitR, 0);
  assert.equal(t.pnl, -0.5);
});

test("runner: maxBars cap near end of session", () => {
  const rows = [
    [100, 100],
    [101, 99],
    [101, 99],
    [101, 99],
  ];
  const t = scoreRunner(rows, 100, 98, 1, 0, { maxBars: 60 });
  assert.equal(t.hit, "time");
  assert.equal(t.heldBars, 3); // end = minutes.length - 1
});

/* ---------------- scale-out (bank 2 units at 1R, run 1 unit) ---------------- */

test("scaleout: full loss before the bank rung", () => {
  const t = scoreScaleOut(bars([[99.5, 97.9]]), 100, 98, 1, 0);
  assert.ok(t.fullLoss);
  assert.ok(!t.banked);
  assert.equal(t.totalR, -3);
  assert.equal(t.pnl, -3 * 2 - 0.5);
});

test("scaleout: bank + runner stopped at BE in the same bar (pessimistic)", () => {
  const t = scoreScaleOut(bars([[102.5, 99]]), 100, 98, 1, 0); // 1R and BE touch in one bar
  assert.ok(t.banked);
  assert.equal(t.runnerExitR, 0);
  assert.equal(t.totalR, 2);
  assert.equal(t.pnl, 4 - 0.5);
});

test("scaleout: bank then runner locks +1R (total 3R)", () => {
  const t = scoreScaleOut(
    bars([
      [102.5, 101], // bank at 1R, no BE touch (low 101 > 100)
      [104.5, 102.2], // rung 2 → runner stop 102
      [102.5, 101.5], // low ≤ 102 → runner out at +1R
    ]),
    100, 98, 1, 0,
  );
  assert.equal(t.totalR, 3);
  assert.equal(t.runnerExitR, 1);
  assert.equal(t.pnl, 6 - 0.5);
});

test("scaleout: bank then runner locks +2R (total 4R)", () => {
  const t = scoreScaleOut(
    bars([
      [102.5, 101], // bank
      [106, 103], // rung 3 → runner stop 104
      [105, 103.5], // low ≤ 104 → runner out at +2R
    ]),
    100, 98, 1, 0,
  );
  assert.equal(t.totalR, 4);
  assert.equal(t.runnerExitR, 2);
  assert.equal(t.pnl, 8 - 0.5);
});

test("scaleout: pessimistic same-bar — 1R and initial stop in one bar", () => {
  const t = scoreScaleOut(bars([[102.5, 97.5]]), 100, 98, 1, 0);
  assert.ok(t.fullLoss);
  assert.equal(t.totalR, -3);
  assert.ok(t.ambiguous);
});

test("scaleout: time exit without ever banking", () => {
  const rows = Array.from({ length: 60 }, () => [100.5, 99.5]).map(([high, low]) => ({ high, low }));
  const t = scoreScaleOut(rows, 100, 98, 1, 0);
  assert.equal(t.hit, "time");
  assert.ok(!t.banked);
  assert.equal(t.totalR, 3 * 0);
  assert.equal(t.pnl, -0.5);
});

test("scaleout: short mirror — bank + runner BE", () => {
  const t = scoreScaleOut(
    bars([
      [99.5, 97.5], // bank at 1R down, no BE touch (high 99.5 < 100)
      [100.5, 99.5], // high ≥ 100 → runner out at BE
    ]),
    100, 102, -1, 0,
  );
  assert.ok(t.banked);
  assert.equal(t.runnerExitR, 0);
  assert.equal(t.totalR, 2);
});
