import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditTrip,
  auditManualTrips,
  auditSummary,
  STRICT_DT_MIN,
  type ManualTrip,
  type SignalRef,
} from "../lib/manualAudit";

const MIN = 60_000;

const trip = (over: Partial<ManualTrip> = {}): ManualTrip => ({
  key: "t1",
  day: "2026-10-08",
  direction: "long",
  qty: 9,
  entryPrice: 21000.5,
  exitPrice: 21010.5,
  entryAtMs: Date.parse("2026-10-08T15:30:00Z"),
  matchedSignal: null,
  ...over,
});

const sig = (over: Partial<SignalRef> = {}): SignalRef => ({
  key: "s1",
  day: "2026-10-08",
  ts: Date.parse("2026-10-08T15:30:30Z"),
  side: "long",
  contracts: 9,
  entry: 21000.75,
  ...over,
});

test("no signal anywhere near → manual (confident)", () => {
  const e = auditTrip(trip(), [sig({ day: "2026-10-07" }), sig({ side: "short" })]);
  assert.equal(e.label, "manual");
  assert.equal(e.nearestSignal, null);
  assert.equal(e.wideCandidates, 0);
});

test("strict time+qty+price match that was never paired → bot-suspect", () => {
  const e = auditTrip(trip(), [sig()]);
  assert.equal(e.label, "bot-suspect");
  assert.equal(e.nearestSignal, "s1");
  assert.ok(e.dtMin !== null && e.dtMin <= 1);
  assert.ok(e.dPx !== null && Math.abs(e.dPx) < 0.5);
  assert.equal(e.dQty, 0);
});

test("two strict candidates → ambiguous (human look)", () => {
  const e = auditTrip(trip(), [sig(), sig({ key: "s2", ts: Date.parse("2026-10-08T15:31:00Z") })]);
  assert.equal(e.label, "ambiguous");
  assert.equal(e.strictCandidates, 2);
});

test("signal inside the wide window but outside strict tolerances → ambiguous", () => {
  // 10 minutes away
  const e = auditTrip(trip(), [sig({ ts: Date.parse("2026-10-08T15:40:00Z") })]);
  assert.equal(e.label, "ambiguous");
  assert.ok(e.dtMin !== null && e.dtMin > STRICT_DT_MIN);
  assert.equal(e.strictCandidates, 0);
  assert.equal(e.wideCandidates, 1);
});

test("qty mismatch blocks the strict match", () => {
  const e = auditTrip(trip({ qty: 5 }), [sig({ contracts: 9 })]);
  assert.equal(e.label, "ambiguous");
  assert.equal(e.strictCandidates, 0);
});

test("already-matched trips are labeled bot", () => {
  const e = auditTrip(trip({ matchedSignal: "s1" }), []);
  assert.equal(e.label, "bot");
});

test("auditManualTrips annotates every trip and auditSummary counts labels", () => {
  const trips = [
    trip({ key: "a" }), // strict match → bot-suspect
    trip({ key: "b", matchedSignal: "x" }), // bot
    trip({ key: "c", day: "2026-10-06" }), // manual (different day)
    trip({ key: "d", direction: "short" }), // manual (wrong side)
  ];
  const labeled = auditManualTrips(trips, [sig()]);
  const s = auditSummary(labeled);
  assert.equal(s["bot-suspect"], 1);
  assert.equal(s.bot, 1);
  assert.equal(s.manual, 2);
  assert.equal(s.ambiguous, 0);
});
