/* Unit tests for the signal-feed tick-cadence rules (lib/signalFeed.ts):
 * the monotonic event-tick decision (fire only when the tail's close
 * ADVANCES or flips tick→candle at the same close) and the poll backstop
 * (skip unless the buffer rolled a bar the emits missed).
 * Pins the fix for the 16-ticks-per-minute footprint-frame stampede,
 * including the vendor frame's backward tail oscillation. */
import { test } from "node:test";
import assert from "node:assert";
import { barCloseMs, eventTickDecision, pollBackstopSkip } from "../lib/signalFeed";

test("barCloseMs: UTC du+t → close epoch (the minute's end)", () => {
  assert.equal(barCloseMs({ t: "02:21", du: "2026-10-11" }), Date.UTC(2026, 9, 11, 2, 22, 0));
  assert.equal(barCloseMs(undefined), null);
  assert.equal(barCloseMs({ t: "now", du: "2026-10-11" }), null);
  assert.equal(barCloseMs({ t: "02:21", du: "garbage" }), null);
});

test("eventTickDecision: the tail advancing (a new bar) always fires", () => {
  assert.equal(
    eventTickDecision({ closeMs: 100, barSrc: "candle" }, { closeMs: 160_100, barSrc: "tick" }),
    "fire",
  );
  assert.equal(
    eventTickDecision({ closeMs: 100, barSrc: "candle" }, { closeMs: 160_100, barSrc: "candle" }),
    "fire",
  );
});

test("eventTickDecision: tick→candle flip at the SAME close fires once", () => {
  assert.equal(
    eventTickDecision({ closeMs: 160_100, barSrc: "tick" }, { closeMs: 160_100, barSrc: "candle" }),
    "fire",
  );
  assert.equal(
    eventTickDecision({ closeMs: 160_100, barSrc: "candle" }, { closeMs: 160_100, barSrc: "candle" }),
    "skip",
  );
});

test("eventTickDecision: backward tail oscillation is skipped", () => {
  // the vendor frame re-replaces the tail with its lagging candle: the
  // close epoch drops one minute — a repeat of an already-seen bar
  assert.equal(
    eventTickDecision({ closeMs: 160_100, barSrc: "candle" }, { closeMs: 100_100, barSrc: "candle" }),
    "skip",
  );
  assert.equal(
    eventTickDecision({ closeMs: 160_100, barSrc: "candle" }, { closeMs: 100_100, barSrc: "tick" }),
    "skip",
  );
});

test("pollBackstopSkip: nothing newer than the last event → poll sleeps", () => {
  const last = { t: "02:21", du: "2026-10-11" };
  const close = Date.UTC(2026, 9, 11, 2, 22, 0);
  // same close (already event-processed) or an OLDER oscillating tail
  assert.equal(pollBackstopSkip(last, close), true);
  assert.equal(pollBackstopSkip({ t: "02:20", du: "2026-10-11" }, close), true);
});

test("pollBackstopSkip: the buffer rolled a bar the emits missed → poll fires", () => {
  const close = Date.UTC(2026, 9, 11, 2, 22, 0);
  const next = { t: "02:22", du: "2026-10-11" };
  assert.equal(pollBackstopSkip(next, close), false);
});

test("pollBackstopSkip: unparseable tail never skips (safety first)", () => {
  assert.equal(pollBackstopSkip(undefined, 100), false);
  assert.equal(pollBackstopSkip({ t: "now", du: "2026-10-11" }, 100), false);
  assert.equal(pollBackstopSkip({ t: "02:21", du: "garbage" }, 100), false);
});
