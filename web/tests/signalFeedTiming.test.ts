/* Unit tests for the signal-feed tick-cadence rules (lib/signalFeed.ts):
 * the event-tick decision (fire only on a new bar or a tick→candle flip)
 * and the poll backstop (sleep while the state is fresh and confirmed).
 * Pins the fix for the 16-ticks-per-minute footprint-frame stampede. */
import { test } from "node:test";
import assert from "node:assert";
import { eventTickDecision, pollBackstopSkip } from "../lib/signalFeed";

test("eventTickDecision: a new completed bar always fires", () => {
  assert.equal(
    eventTickDecision({ barKey: "2026-10-11|02:20", barSrc: "candle" }, { barKey: "2026-10-11|02:21", barSrc: "tick" }),
    "fire",
  );
  assert.equal(
    eventTickDecision({ barKey: "2026-10-11|02:20", barSrc: "candle" }, { barKey: "2026-10-11|02:21", barSrc: "candle" }),
    "fire",
  );
});

test("eventTickDecision: the tick→candle confirmation flip fires once", () => {
  assert.equal(
    eventTickDecision({ barKey: "2026-10-11|02:21", barSrc: "tick" }, { barKey: "2026-10-11|02:21", barSrc: "candle" }),
    "fire",
  );
});

test("eventTickDecision: frames that merge nothing are skipped", () => {
  // same bar, still tick-source (frame arrived but merged nothing)
  assert.equal(
    eventTickDecision({ barKey: "2026-10-11|02:21", barSrc: "tick" }, { barKey: "2026-10-11|02:21", barSrc: "tick" }),
    "skip",
  );
  // same bar, already confirmed (later frame re-merges older bars)
  assert.equal(
    eventTickDecision({ barKey: "2026-10-11|02:21", barSrc: "candle" }, { barKey: "2026-10-11|02:21", barSrc: "candle" }),
    "skip",
  );
});

test("pollBackstopSkip: fresh candle-confirmed bar → poll sleeps", () => {
  // bar "02:21" closed at 02:22:00 UTC; 10s later = fresh + confirmed
  const closeMs = Date.UTC(2026, 9, 11, 2, 22, 0);
  const last = { t: "02:21", du: "2026-10-11", source: "candle" };
  assert.equal(pollBackstopSkip(last, closeMs + 10_000), true);
  assert.equal(pollBackstopSkip(last, closeMs + 44_000), true);
});

test("pollBackstopSkip: aged or unconfirmed bar → poll resumes", () => {
  const closeMs = Date.UTC(2026, 9, 11, 2, 22, 0);
  const candle = { t: "02:21", du: "2026-10-11", source: "candle" };
  assert.equal(pollBackstopSkip(candle, closeMs + 46_000), false); // aged — emits died
  const tickBuilt = { t: "02:21", du: "2026-10-11", source: "tick" };
  assert.equal(pollBackstopSkip(tickBuilt, closeMs + 2_000), false); // unconfirmed — heal path
});

test("pollBackstopSkip: no bar / unparseable stamps never skip (safety first)", () => {
  assert.equal(pollBackstopSkip(undefined, Date.now()), false);
  assert.equal(pollBackstopSkip({ t: "now", du: "2026-10-11", source: "tick" }, Date.now()), false);
  assert.equal(pollBackstopSkip({ t: "02:21", du: "garbage", source: "candle" }, Date.now()), false);
});
