/* Unit tests for the signal-feed tick-cadence rules (lib/signalFeed.ts):
 * the monotonic max-close event decision and the poll backstop. Pins the
 * fix for the footprint-frame stampede, including the vendor frame's
 * backward tail oscillation and re-advance re-fires. */
import { test } from "node:test";
import assert from "node:assert";
import { barCloseMs, eventTickDecision, pollBackstopSkip } from "../lib/signalFeed";

test("barCloseMs: UTC du+t → close epoch (the minute's end)", () => {
  assert.equal(barCloseMs({ t: "02:21", du: "2026-10-11" }), Date.UTC(2026, 9, 11, 2, 22, 0));
  assert.equal(barCloseMs(undefined), null);
  assert.equal(barCloseMs({ t: "now", du: "2026-10-11" }), null);
  assert.equal(barCloseMs({ t: "02:21", du: "garbage" }), null);
});

const M = (min: number) => Date.UTC(2026, 9, 11, 2, min, 0);

test("eventTickDecision: tail past the max (a new bar) fires and raises the max", () => {
  const d = eventTickDecision({ maxCloseMs: M(21), srcAtMax: "candle" }, { closeMs: M(22), barSrc: "tick" });
  assert.deepEqual(d, { fire: true, maxCloseMs: M(22), srcAtMax: "tick" });
  const d2 = eventTickDecision({ maxCloseMs: M(21), srcAtMax: "candle" }, { closeMs: M(22), barSrc: "candle" });
  assert.deepEqual(d2, { fire: true, maxCloseMs: M(22), srcAtMax: "candle" });
});

test("eventTickDecision: tick→candle flip AT the max fires once, then never again", () => {
  const flip = eventTickDecision({ maxCloseMs: M(22), srcAtMax: "tick" }, { closeMs: M(22), barSrc: "candle" });
  assert.deepEqual(flip, { fire: true, maxCloseMs: M(22), srcAtMax: "candle" });
  const again = eventTickDecision({ maxCloseMs: M(22), srcAtMax: "candle" }, { closeMs: M(22), barSrc: "candle" });
  assert.equal(again.fire, false);
});

test("eventTickDecision: backward oscillation and its re-advance are ignored", () => {
  // tail dips to the vendor's lagging candle…
  const dip = eventTickDecision({ maxCloseMs: M(22), srcAtMax: "candle" }, { closeMs: M(21), barSrc: "candle" });
  assert.deepEqual(dip, { fire: false, maxCloseMs: M(22), srcAtMax: "candle" });
  // …and re-advances to the already-confirmed max: still no fire
  const reAdvance = eventTickDecision({ maxCloseMs: M(22), srcAtMax: "candle" }, { closeMs: M(22), barSrc: "tick" });
  assert.equal(reAdvance.fire, false);
  const reConfirm = eventTickDecision({ maxCloseMs: M(22), srcAtMax: "candle" }, { closeMs: M(22), barSrc: "candle" });
  assert.equal(reConfirm.fire, false);
});

test("pollBackstopSkip: tail at or below the event max → poll sleeps", () => {
  assert.equal(pollBackstopSkip({ t: "02:21", du: "2026-10-11" }, M(22)), true); // same close as the max
  assert.equal(pollBackstopSkip({ t: "02:20", du: "2026-10-11" }, M(22)), true); // oscillation dip
});

test("pollBackstopSkip: the buffer rolled a bar the emits missed → poll fires", () => {
  assert.equal(pollBackstopSkip({ t: "02:23", du: "2026-10-11" }, M(22)), false);
});

test("pollBackstopSkip: unparseable tail never skips (safety first)", () => {
  assert.equal(pollBackstopSkip(undefined, M(22)), false);
  assert.equal(pollBackstopSkip({ t: "now", du: "2026-10-11" }, M(22)), false);
  assert.equal(pollBackstopSkip({ t: "02:21", du: "garbage" }, M(22)), false);
});
