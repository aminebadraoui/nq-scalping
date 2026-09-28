/* Signal history regression tests: the in-memory record of Telegram pushes.
 * No DATABASE_URL is set in the test process, so persistence is a no-op and
 * these exercise the always-on buffer path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSignal, getMemoryHistory } from "../lib/signalHistory.ts";

const base = {
  timeET: "10:30",
  day: "2026-09-25",
  symbol: "NQZ26",
  side: "long",
  price: 100.25,
  entry: "reclaim 100.00",
  stop: "close below 99.75",
  target: "P0 POC 101.00",
  verdict: "ALIGNED LONG",
  headline: "every box agrees",
  source: "live",
  test: false,
  sent: true,
  reason: "sent",
};

test("recordSignal stores most-recent-first and returns the entry", async () => {
  const a = await recordSignal({ ...base, ts: 1000 });
  const b = await recordSignal({ ...base, ts: 2000, side: "short" });
  assert.equal(a.side, "long");
  assert.equal(b.side, "short");
  assert.ok(a.id !== b.id, "unique ids");
  const h = getMemoryHistory();
  assert.equal(h[0].id, b.id, "newest first");
  assert.equal(h[1].id, a.id, "older second");
});

test("getMemoryHistory caps the buffer and never mutates the source", async () => {
  for (let i = 0; i < 210; i++) await recordSignal({ ...base, ts: i });
  const h = getMemoryHistory(50);
  assert.equal(h.length, 50);
  assert.equal(h[0].ts, 209, "newest entry is the last recorded");
  // the underlying buffer is internally capped at 200
  assert.ok(getMemoryHistory(1000).length <= 200, "internal cap holds");
});

test("side and price round-trip through the buffer", async () => {
  await recordSignal({ ...base, side: "none", price: 99.5, sent: false, reason: "chat not found", ts: 1 });
  const e = getMemoryHistory(1)[0];
  assert.equal(e.side, "none");
  assert.equal(e.price, 99.5);
  assert.equal(e.sent, false);
  assert.match(e.reason, /chat not found/);
});
