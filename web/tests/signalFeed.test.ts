/* Unit tests for the expansion retrace resolver (lib/signalFeed.ts):
 * the pure fill/expire/wait decision + the feed-clock gap helper. */
import { test } from "node:test";
import assert from "node:assert";
import { resolveRetrace, feedMinutesGap, retraceUseLimit, momentumLimitParams } from "../lib/signalFeed";

const bar = (o: number, high: number, low: number) => ({ o, high, low });

test("long: first touch fills at the limit when the bar opens above it", () => {
  const res = resolveRetrace([bar(100, 100.5, 99.75), bar(100.25, 100.4, 99.4)], "long", 99.5, 5);
  assert.deepEqual(res, { status: "fill", fill: 99.5, barIdx: 1 });
});

test("long: gap through the level fills at the better open", () => {
  const res = resolveRetrace([bar(99.2, 99.9, 98.8)], "long", 99.5, 5);
  assert.deepEqual(res, { status: "fill", fill: 99.2, barIdx: 0 });
});

test("short: mirror — touch fills at the limit, gap-through at the open", () => {
  assert.deepEqual(resolveRetrace([bar(100, 100.9, 99.6)], "short", 100.5, 5), { status: "fill", fill: 100.5, barIdx: 0 });
  assert.deepEqual(resolveRetrace([bar(100.8, 101.2, 100.5)], "short", 100.5, 5), { status: "fill", fill: 100.8, barIdx: 0 });
});

test("expires once the window elapses without a touch", () => {
  const bars = [bar(101, 101.4, 100.6), bar(101.2, 101.6, 100.9), bar(101.3, 101.8, 101.0), bar(101.5, 101.9, 101.1), bar(101.6, 102.0, 101.2)];
  assert.deepEqual(resolveRetrace(bars, "long", 100.5, 5), { status: "expired" });
});

test("waits while fewer than the window's bars have printed", () => {
  assert.deepEqual(resolveRetrace([bar(101, 101.4, 100.6)], "long", 100.5, 5), { status: "wait" });
  assert.deepEqual(resolveRetrace([], "long", 100.5, 5), { status: "wait" });
});

test("feedMinutesGap: adjacent, wrap, garbage", () => {
  assert.equal(feedMinutesGap("09:30", "09:31"), 1);
  assert.equal(feedMinutesGap("23:59", "00:00"), 1); // midnight wrap
  assert.equal(feedMinutesGap("09:30", "09:32"), 2);
  assert.equal(feedMinutesGap("9:30", "09:31"), null);
  assert.equal(feedMinutesGap("", "09:31"), null);
});

test("retraceUseLimit: resting broker limit is the default; 0 opts out", () => {
  const saved = process.env.CROSSTRADE_LIMIT_ENTRIES;
  try {
    delete process.env.CROSSTRADE_LIMIT_ENTRIES;
    assert.equal(retraceUseLimit(false), true); // default = limit-only
    process.env.CROSSTRADE_LIMIT_ENTRIES = "1";
    assert.equal(retraceUseLimit(false), true);
    process.env.CROSSTRADE_LIMIT_ENTRIES = "0"; // explicit escape hatch
    assert.equal(retraceUseLimit(false), false);
  } finally {
    if (saved === undefined) delete process.env.CROSSTRADE_LIMIT_ENTRIES;
    else process.env.CROSSTRADE_LIMIT_ENTRIES = saved;
  }
});

test("retraceUseLimit: scale-out pairs keep the market path (no limit leg)", () => {
  const saved = process.env.CROSSTRADE_LIMIT_ENTRIES;
  try {
    delete process.env.CROSSTRADE_LIMIT_ENTRIES;
    assert.equal(retraceUseLimit(true), false);
  } finally {
    if (saved === undefined) delete process.env.CROSSTRADE_LIMIT_ENTRIES;
    else process.env.CROSSTRADE_LIMIT_ENTRIES = saved;
  }
});

test("momentumLimitParams: flush rests AT the signal close for 9 min (the flushLimit arm)", () => {
  assert.deepEqual(momentumLimitParams("flush", 30780.375, "long"), { level: 30780.375, ttlMin: 9 });
  assert.deepEqual(momentumLimitParams("flush", 30784.75, "short"), { level: 30784.75, ttlMin: 9 });
});

test("momentumLimitParams: expansion retrace rests 1 pt behind the close for 5 min (unchanged)", () => {
  assert.deepEqual(momentumLimitParams("expansion", 31261.375, "long"), { level: 31260.375, ttlMin: 5 });
  assert.deepEqual(momentumLimitParams("expansion", 30908.75, "short"), { level: 30909.75, ttlMin: 5 });
});
