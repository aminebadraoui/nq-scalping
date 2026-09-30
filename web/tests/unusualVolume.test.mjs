/* Unusual-volume alert context + pullback watch (stage 2). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barPocOf,
  pocStepTicks,
  closePosOf,
  barImbOf,
  nearestLevelOf,
  uvWatchCheck,
} from "../lib/unusualVolume.ts";

const L = (spec) =>
  Object.fromEntries(spec.map(([p, b, s]) => [String(p), [b, s]]));

/* ---------------- stage 1 context ---------------- */

test("bar POC is the tick with the most volume", () => {
  const poc = barPocOf(L([[100.5, 5, 5], [100.25, 40, 10], [100, 10, 5]]));
  assert.deepEqual(poc, { price: 100.25, vol: 50 });
  assert.equal(barPocOf(undefined), null);
  assert.equal(barPocOf({}), null);
});

test("POC migration steps in ticks", () => {
  assert.equal(pocStepTicks(null, 100), null, "missing prev");
  assert.equal(pocStepTicks(100, null), null, "missing current");
  assert.equal(pocStepTicks(100, 100.5), 2, "+2 ticks");
  assert.equal(pocStepTicks(100, 99.75), -1, "-1 tick");
  assert.equal(pocStepTicks(100, 100), 0, "flat");
});

test("close position needs OHLC and a real range", () => {
  assert.equal(closePosOf(100, 99, 0), null, "no close (footprint-only bar)");
  assert.equal(closePosOf(100, 100, 100), null, "flat range");
  assert.ok(Math.abs(closePosOf(100, 99, 99.9) - 0.9) < 1e-9);
  assert.ok(Math.abs(closePosOf(100, 99, 99.1) - 0.1) < 1e-9);
});

test("stacked imbalance on the alert bar's own rows", () => {
  // four descending ticks, each 10:2 buy — 4 consecutive buy-imbalance rows
  const stack = barImbOf(L([[100.75, 10, 2], [100.5, 10, 2], [100.25, 10, 2], [100, 10, 2]]));
  assert.ok(stack, "stack detected");
  assert.equal(stack.side, "buy");
  assert.equal(stack.len, 4);
  assert.equal(stack.from, 100.75);
  assert.equal(stack.to, 100);
  // balanced rows -> no 3:1 imbalance rows at all
  assert.equal(barImbOf(L([[100.5, 10, 10], [100.25, 10, 10]])), null);
  assert.equal(barImbOf(undefined), null);
});

test("nearest level: POC / VAH / VAL / LVN edges, with an at-threshold", () => {
  const levels = [
    { label: "P4 PriorDay", poc: 20500, vah: 20510, val: 20480, lvns: [[20490, 20495]] },
    { label: "P0 Live", poc: 20100, vah: 20110, val: 20090, lvns: [] },
  ];
  const near = nearestLevelOf(levels, 20496, 10);
  assert.equal(near.label, "P4 PriorDay");
  assert.equal(near.kind, "LVN");
  assert.equal(near.value, 20495);
  assert.equal(near.dist, 1);
  // closest wins over nearer-but-further candidates
  const at = nearestLevelOf(levels, 20501, 10);
  assert.equal(at.kind, "POC");
  assert.equal(at.dist, 1);
  // nothing within maxPts
  assert.equal(nearestLevelOf(levels, 20800, 10), null);
});

/* ---------------- stage 2 watch ---------------- */

const m = (t, high, low, buy, sell, c = 0) => ({ t, high, low, buy, sell, c });

function buyWatch(armedAt = 0, started = false, pullExtreme = 0, startIdx = -1) {
  // alert bar: 17:04, strong buy, 72/28, high 105.0, low 103.5
  return {
    side: "buy",
    high: 105.0,
    low: 103.5,
    armedIdx: 4,
    armedAt,
    started,
    startIdx,
    pullExtreme,
  };
}

const BASE = [
  m("17:00", 102.0, 101.0, 10, 10),
  m("17:01", 101.6, 100.8, 10, 10),
  m("17:02", 102.2, 101.4, 10, 10),
  m("17:03", 103.0, 102.2, 10, 10),
  m("17:04", 105.0, 103.5, 72, 28, 104.8), // ← the unusual buy alert bar
];

test("watch: pullback starts on the first aggressive counter-side bar", () => {
  const mins = [...BASE, m("17:05", 104.2, 103.6, 30, 70, 103.7)]; // -40% delta
  const ev = uvWatchCheck(buyWatch(), mins, 30_000, 6 * 60_000);
  assert.equal(ev.kind, "start");
  assert.equal(ev.flipTo, "down");
  assert.equal(ev.idx, 5);
  assert.equal(ev.pullExtreme, 103.6);
  assert.equal(ev.price, 103.7);
});

test("watch: with-side bars do not start the pullback", () => {
  const mins = [...BASE, m("17:05", 105.4, 104.4, 70, 30, 105.2)]; // +40% — same side
  assert.equal(uvWatchCheck(buyWatch(), mins, 30_000, 6 * 60_000), null);
});

test("watch: weak bars do not start the pullback (< 15% delta)", () => {
  const mins = [...BASE, m("17:05", 104.8, 103.8, 47, 53, 104.2)]; // -6% — noise
  assert.equal(uvWatchCheck(buyWatch(), mins, 30_000, 6 * 60_000), null);
});

test("watch: flush of the pullback low reclaimed one-sidedly = long", () => {
  const w = buyWatch(0, true, 103.6, 5);
  const mins = [
    ...BASE,
    m("17:05", 104.2, 103.6, 30, 70, 103.7), // pullback (start bar)
    m("17:06", 103.8, 103.2, 40, 60, 103.3), // flush below 103.6 - 0.25
    m("17:07", 104.1, 103.6, 80, 20, 104.0), // one-sided buy reclaim, last bar
  ];
  const ev = uvWatchCheck(w, mins, 60_000, 6 * 60_000);
  assert.equal(ev.kind, "reclaim");
  assert.equal(ev.dir, "long");
  assert.equal(ev.entry, 104.0);
  assert.equal(ev.stop, 103.1); // pullback low 103.6 - 0.5
  assert.equal(ev.target, 104.9); // 1R
});

test("watch: a reclaim bar that is not the last bar does not fire (no lookahead)", () => {
  const w = buyWatch(0, true, 103.6, 5);
  const mins = [
    ...BASE,
    m("17:05", 104.2, 103.6, 30, 70, 103.7),
    m("17:06", 103.8, 103.2, 40, 60, 103.3),
    m("17:07", 104.1, 103.6, 80, 20, 104.0), // reclaim — but not last
    m("17:08", 104.4, 104.0, 55, 45, 104.2),
  ];
  assert.equal(uvWatchCheck(w, mins, 60_000, 6 * 60_000), null);
});

test("watch: a 50/50 reclaim bar does not fire", () => {
  const w = buyWatch(0, true, 103.6, 5);
  const mins = [
    ...BASE,
    m("17:05", 104.2, 103.6, 30, 70, 103.7),
    m("17:06", 103.8, 103.2, 40, 60, 103.3),
    m("17:07", 104.1, 103.6, 50, 50, 104.0),
  ];
  assert.equal(uvWatchCheck(w, mins, 60_000, 6 * 60_000), null);
});

test("watch: two bars past the whole alert bar cancel the watch", () => {
  const mins = [
    ...BASE,
    m("17:05", 103.5, 103.0, 47, 53, 103.1), // mid 103.25 < alert low 103.5, but only -6% delta (no start)
    m("17:06", 103.4, 102.8, 20, 80, 102.9), // mid 103.1 < 103.5 — second bar past
  ];
  const ev = uvWatchCheck(buyWatch(), mins, 60_000, 6 * 60_000);
  assert.equal(ev.kind, "cancelled");
});

test("watch: a single deep flush bar does not cancel", () => {
  const mins = [...BASE, m("17:05", 103.8, 103.2, 40, 60, 103.3)]; // mid 103.5 — not past
  assert.equal(uvWatchCheck(buyWatch(), mins, 60_000, 6 * 60_000).kind, "start");
});

test("watch: expires after the window", () => {
  const ev = uvWatchCheck(buyWatch(0), BASE, 7 * 60_000, 6 * 60_000);
  assert.equal(ev.kind, "expired");
});

test("watch: sell-side mirror — pullback up, flush high, short reclaim", () => {
  const w = {
    side: "sell",
    high: 101.0,
    low: 99.5,
    armedIdx: 4,
    armedAt: 0,
    started: true,
    startIdx: 5,
    pullExtreme: 101.4, // pullback high
  };
  const mins = [
    m("17:00", 102.0, 101.0, 10, 10),
    m("17:01", 101.6, 100.8, 10, 10),
    m("17:02", 101.0, 99.6, 10, 10),
    m("17:03", 100.2, 98.8, 10, 10),
    m("17:04", 99.9, 98.5, 28, 72, 98.7), // ← the unusual sell alert bar
    m("17:05", 101.2, 100.2, 70, 30, 101.0), // pullback up
    m("17:06", 101.8, 101.2, 60, 40, 101.7), // flush above 101.4 + 0.25
    m("17:07", 101.2, 100.6, 20, 80, 100.8), // one-sided sell reclaim, last bar
  ];
  const ev = uvWatchCheck(w, mins, 60_000, 6 * 60_000);
  assert.equal(ev.kind, "reclaim");
  assert.equal(ev.dir, "short");
  assert.equal(ev.entry, 100.8);
  assert.equal(ev.stop, 101.9); // pullback high 101.4 + 0.5
  assert.ok(Math.abs(ev.target - 99.7) < 1e-9); // 1R
});
