/* Signal engine regression tests: the server-side signal must recompute the
 * exact same events as the collected-file analysis, and the live-minute
 * conversion must re-key to the feed clock. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, extractFootprint } from "../lib/gcdata.ts";
import { computeSignal, liveMinutesToFootprint, liveVwap } from "../lib/signalEngine.ts";

const DATE = "2026-09-25";
const SESSION = "RTH";

test("computeSignal analysis matches analyze() on collected data", async () => {
  const a = await analyze(DATE, SESSION);
  assert.ok(a, "analyze returned data");
  const fp = await extractFootprint(DATE, SESSION);
  assert.ok(fp, "footprint returned data");
  const last = fp.minutes[fp.minutes.length - 1];
  const snap = computeSignal(fp.minutes, null, {
    lastPrice: last.c || last.high,
    vwap: a.vwap,
    sessionHigh: fp.maxPrice,
    sessionLow: fp.minPrice,
    gamma: null,
    symbol: "NQZ26",
    source: "collected",
  });
  assert.ok(snap.analysis, "analysis computed");
  assert.equal(snap.analysis.absorption.length, a.absorption.length, "absorption parity");
  assert.equal(snap.analysis.reclaims.length, a.reclaims.length, "reclaim parity");
  assert.equal(snap.analysis.alerts.length, a.alerts.length, "alert parity");
  assert.equal(snap.analysis.imbalance.stacks.length, a.imbalance.stacks.length, "stack parity");
  assert.equal(snap.analysis.vwap, a.vwap, "vwap parity");
  // the read is wired end to end
  assert.equal(snap.mech.ingredients.length, 6);
  assert.equal(snap.pa.rows.length, 6);
  assert.ok(typeof snap.signal.tone === "string");
  assert.equal(snap.source, "collected");
});

test("liveMinutesToFootprint re-keys UTC minutes to the feed clock and builds levels", () => {
  const mins = [
    {
      t: "14:30",
      du: "2026-09-25",
      o: 100,
      h: 101,
      l: 99,
      c: 100.5,
      vol: 10,
      buy: 6,
      sell: 4,
      live: true,
      levels: { "100.00": [3, 1], "100.25": [3, 3] },
    },
  ];
  const fp = liveMinutesToFootprint(mins);
  assert.equal(fp.length, 1);
  // America/Chicago in September = CDT (UTC-5): 14:30Z -> 09:30 feed clock
  assert.equal(fp[0].t, "09:30");
  assert.equal(fp[0].d, "2026-09-25");
  assert.equal(fp[0].levels.length, 2);
  assert.ok(fp[0].imb);
  assert.equal(fp[0].buy, 6);
  assert.equal(fp[0].sell, 4);
});

test("liveVwap weights typical price by volume", () => {
  const mins = [
    { t: "09:30", d: "2026-09-25", o: 100, c: 100, high: 100, low: 100, buy: 10, sell: 10, delta: 0, vwap: 100, levels: [], imb: null },
    { t: "09:31", d: "2026-09-25", o: 101, c: 101, high: 101, low: 101, buy: 20, sell: 20, delta: 0, vwap: 101, levels: [], imb: null },
  ];
  const expected = (100 * 20 + 101 * 40) / 60;
  assert.ok(Math.abs(liveVwap(mins) - expected) < 1e-9, `got ${liveVwap(mins)}, want ${expected}`);
});
