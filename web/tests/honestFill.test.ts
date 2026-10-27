/* lib/honestFill.ts — the honest fill model every backtest scores with. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketFillEstimate, closeEstimate, simulateHonest, MNQ_FEE_PTS } from "../lib/honestFill";

test("market fill estimate: conservative p80 by default, p50 as the optimistic bound", () => {
  const bar = { high: 110, low: 100, buy: 80, sell: 20 };
  assert.equal(marketFillEstimate(bar, 1), 109.5); // p80: 100 + 0.94·10
  assert.equal(marketFillEstimate(bar, 1, "p50"), 107.75); // p50: 100 + 0.77·10, on tick
  // for a short the trade-side share is the SELL share (20%) → p80 0.55 below the high
  assert.equal(marketFillEstimate(bar, -1), 104.5);
  // a true close always wins
  assert.equal(marketFillEstimate({ ...bar, c: 107 }, 1), 107);
});

test("close estimate: median position by buy share, true close when present", () => {
  assert.equal(closeEstimate({ high: 110, low: 100, buy: 50, sell: 50 }), 105);
  assert.equal(closeEstimate({ high: 110, low: 100, c: 101 }), 101);
});

test("limit entry needs a one-tick trade-through; a touch is not a fill", () => {
  const bars = [
    { high: 101, low: 100, buy: 50, sell: 50 },
    { high: 101, low: 99, buy: 50, sell: 50 }, // touches 99, no trade-through
    { high: 100, low: 98.5, buy: 50, sell: 50 }, // trades through 99
    { high: 104, low: 99, buy: 50, sell: 50 },
  ];
  const r = simulateHonest(bars, { dir: 1, signalIdx: 0, entry: { kind: "limit", price: 99, ttlBars: 5 }, stopPts: 3, targetPts: 3 });
  assert.ok(r?.filled);
  assert.equal(r.fillIdx, 2);
  assert.equal(r.entry, 99);
  assert.equal(r.hit, "target"); // 104 ≥ 102 + tick on the bar after the fill
  assert.equal(r.netPts, 3 - MNQ_FEE_PTS);
});

test("a limit that never trades through within the TTL is a no-fill", () => {
  const bars = [
    { high: 101, low: 100 },
    { high: 102, low: 99 },
    { high: 103, low: 99.5 },
  ];
  const r = simulateHonest(bars, { dir: 1, signalIdx: 0, entry: { kind: "limit", price: 99, ttlBars: 2 }, stopPts: 3, targetPts: 3 });
  assert.equal(r?.hit, "nofill");
  assert.equal(r?.filled, false);
});

test("the fill bar is checked for the stop and never credits the target", () => {
  const bars = [
    { high: 101, low: 100 },
    { high: 104, low: 95 }, // fills limit 99, spans stop 96 and target 102
  ];
  const r = simulateHonest(bars, { dir: 1, signalIdx: 0, entry: { kind: "limit", price: 99, ttlBars: 3 }, stopPts: 3, targetPts: 3 });
  assert.equal(r?.hit, "stop");
  assert.equal(r?.exit, 95.75); // 96 − 0.25 slip
});

test("stop entry fills at the trigger plus slippage", () => {
  const bars = [
    { high: 101, low: 100 },
    { high: 103, low: 100.5 },
    { high: 108, low: 101.5 },
  ];
  const r = simulateHonest(bars, { dir: 1, signalIdx: 0, entry: { kind: "stop", price: 102, ttlBars: 3 }, stopPts: 2, targetPts: 4 });
  assert.equal(r?.entry, 102.25);
  assert.equal(r?.hit, "target");
});

test("market entry: whole next bar is after the fill", () => {
  const bars = [
    { high: 101, low: 99, c: 100 },
    { high: 104, low: 99.5, o: 100.5 },
  ];
  const r = simulateHonest(bars, { dir: 1, signalIdx: 0, entry: { kind: "market" }, stopPts: 2, targetPts: 3 });
  assert.equal(r?.entry, 100.75); // true open + slip
  assert.equal(r?.hit, "target");
});
