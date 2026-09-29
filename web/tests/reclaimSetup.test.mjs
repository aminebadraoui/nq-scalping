/* Live sweep-reclaim + one-sided detector. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOneSidedReclaim } from "../lib/reclaimSetup.ts";

function m(t, high, low, buy, sell, c = 0, d = "2026-09-28") {
  return { t, d, o: c || low, c, high, low, buy, sell, delta: buy - sell, vwap: (high + low) / 2, levels: [], imb: null };
}

test("detects a one-sided buy reclaim on the last bar", () => {
  const mins = [
    m("17:00", 102.0, 101.0, 10, 10),
    m("17:01", 101.5, 100.6, 10, 10),
    m("17:02", 101.0, 100.4, 10, 10),
    m("17:03", 100.8, 100.0, 10, 10),  // establishes running low 100.0
    m("17:04", 100.2, 99.6, 10, 10),   // sweep below 100.0 - 0.25
    m("17:05", 100.8, 100.0, 80, 20, 100.5), // one-sided buy reclaim (last bar)
  ];
  const r = detectOneSidedReclaim(mins);
  assert.ok(r, "setup detected");
  assert.equal(r.dir, "long");
  assert.equal(r.extreme, 100.0);
  assert.equal(r.entry, 100.5);
  assert.equal(r.stop, 99.5);
  assert.equal(r.target, 101.5);
  assert.ok(r.buyPct >= 0.65);
});

test("does not fire when the reclaim bar is not one-sided", () => {
  const mins = [
    m("17:00", 102.0, 101.0, 10, 10),
    m("17:01", 101.5, 100.6, 10, 10),
    m("17:02", 101.0, 100.4, 10, 10),
    m("17:03", 100.8, 100.0, 10, 10),
    m("17:04", 100.2, 99.6, 10, 10),
    m("17:05", 100.8, 100.0, 50, 50, 100.5), // 50/50 — not one-sided
  ];
  assert.equal(detectOneSidedReclaim(mins), null);
});

test("does not fire when the reclaim bar is not the last bar", () => {
  const mins = [
    m("17:00", 102.0, 101.0, 10, 10),
    m("17:01", 101.5, 100.6, 10, 10),
    m("17:02", 101.0, 100.4, 10, 10),
    m("17:03", 100.8, 100.0, 10, 10),
    m("17:04", 100.2, 99.6, 10, 10),
    m("17:05", 100.8, 100.0, 80, 20, 100.5), // reclaim, one-sided, but not last
    m("17:06", 101.2, 100.6, 10, 10),         // another bar after it
  ];
  assert.equal(detectOneSidedReclaim(mins), null);
});

test("detects a one-sided sell reclaim (short)", () => {
  const mins = [
    m("17:00", 100.0, 99.0, 10, 10),
    m("17:01", 100.5, 99.4, 10, 10),
    m("17:02", 100.6, 100.0, 10, 10),
    m("17:03", 101.0, 100.4, 10, 10),  // running high 101.0
    m("17:04", 101.6, 101.1, 10, 10),  // sweep above 101.0 + 0.25
    m("17:05", 101.0, 100.0, 20, 80, 100.2), // one-sided sell reclaim (last bar)
  ];
  const r = detectOneSidedReclaim(mins);
  assert.ok(r, "setup detected");
  assert.equal(r.dir, "short");
  assert.equal(r.extreme, 100.6); // running high before the sweep bar
  assert.equal(r.entry, 100.2);
  assert.equal(r.stop, 101.1);    // 100.6 + 0.5
  assert.ok(Math.abs(r.target - 99.3) < 1e-6); // entry - risk (0.9)
});
