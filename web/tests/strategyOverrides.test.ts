/* Unit tests for the self-improvement gate engine (lib/strategyOverrides.ts):
 * every override gate blocks exactly what it should, and the default state
 * (no overrides) lets everything through. */
import { test } from "node:test";
import assert from "node:assert";
import { decideSignal, type Override, type GateContext } from "../lib/strategyOverrides";

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  families: ["momentum_expansion", "momentum", "all"],
  hourET: 22,
  side: "long",
  breakFrac: 0.8,
  riskPts: 5,
  breakRangeR: 1.6,
  cumDelta: 500,
  firstOfDay: false,
  ...over,
});

const ov = (family: string, gate: string, value: unknown): Override => ({
  id: 1,
  family,
  gate,
  value,
});

test("no overrides → everything allowed", () => {
  assert.deepEqual(decideSignal([], ctx()), { allow: true, reasons: [] });
});

test("enable=false on the family blocks it", () => {
  const d = decideSignal([ov("momentum_expansion", "enable", { enabled: false })], ctx());
  assert.equal(d.allow, false);
  assert.match(d.reasons[0], /disabled/);
});

test("hour_veto blocks the matching hour only", () => {
  const o = ov("momentum_expansion", "hour_veto", { hours: [0, 1, 2], bucket: "globex_late" });
  assert.equal(decideSignal([o], ctx({ hourET: 1 })).allow, false);
  assert.equal(decideSignal([o], ctx({ hourET: 22 })).allow, true);
});

test("trend_filter blocks against-trend signals only", () => {
  const o = ov("momentum_expansion", "trend_filter", { required: true, on: "cumDelta" });
  assert.equal(decideSignal([o], ctx({ side: "long", cumDelta: 500 })).allow, true);
  assert.equal(decideSignal([o], ctx({ side: "long", cumDelta: -500 })).allow, false);
  assert.equal(decideSignal([o], ctx({ side: "short", cumDelta: -500 })).allow, true);
  // unknown delta → allow (fail open)
  assert.equal(decideSignal([o], ctx({ cumDelta: null })).allow, true);
});

test("min_break_frac / max_risk / first_only gates", () => {
  assert.equal(decideSignal([ov("momentum", "min_break_frac", { min: 0.85 })], ctx({ breakFrac: 0.8 })).allow, false);
  assert.equal(decideSignal([ov("momentum", "min_break_frac", { min: 0.85 })], ctx({ breakFrac: 0.9 })).allow, true);
  assert.equal(decideSignal([ov("all", "max_risk", { maxRiskPts: 4 })], ctx({ riskPts: 5 })).allow, false);
  assert.equal(decideSignal([ov("all", "first_only", { required: true })], ctx({ firstOfDay: false })).allow, false);
  assert.equal(decideSignal([ov("all", "first_only", { required: true })], ctx({ firstOfDay: true })).allow, true);
});

test("generic family matches apply to children (momentum → expansion)", () => {
  const d = decideSignal([ov("momentum", "hour_veto", { hours: [22] })], ctx({ hourET: 22 }));
  assert.equal(d.allow, false);
});
