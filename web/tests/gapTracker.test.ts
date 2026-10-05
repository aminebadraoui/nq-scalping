/* Gap-tracker tests — pure bar-array math, no network. Rules re-derived
 * from the docstrings in lib/gapTracker.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapInventory, gapChips, MIN_GAP_PTS, type GapBar } from "../lib/gapTracker";

function bar(t: string, low: number, high: number): GapBar {
  return { t, low, high };
}

/* ---------------- inventory ---------------- */

test("a bar whose low sits above the prior high is a gap up", () => {
  const gaps = gapInventory([bar("09:30", 100, 101), bar("09:31", 103, 104)]);
  assert.equal(gaps.length, 1);
  const g = gaps[0];
  assert.equal(g.dir, "up");
  assert.equal(g.bottom, 101); // prior high
  assert.equal(g.top, 103); // current low
  assert.equal(g.size, 2);
  assert.equal(g.fillPct, 0);
});

test("a bar whose high sits below the prior low is a gap down", () => {
  const gaps = gapInventory([bar("09:30", 100, 101), bar("09:31", 97, 98)]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].dir, "down");
  assert.equal(gaps[0].bottom, 98); // current high
  assert.equal(gaps[0].top, 100); // prior low
});

test("overlapping bars are not gaps", () => {
  const gaps = gapInventory([bar("09:30", 100, 101), bar("09:31", 100.5, 101.5)]);
  assert.equal(gaps.length, 0);
});

test("sub-tick gaps are filtered out", () => {
  const gaps = gapInventory([bar("09:30", 100, 101), bar("09:31", 101.1, 102)]);
  assert.equal(gaps.length, 0); // 0.1 pt < MIN_GAP_PTS
  assert.equal(MIN_GAP_PTS, 0.25);
});

test("fill tracking: a later bar retrading the whole zone fills 100%", () => {
  const bars = [bar("09:30", 100, 101), bar("09:31", 103, 104), bar("09:32", 100.5, 103.5)];
  const gaps = gapInventory(bars);
  assert.equal(gaps[0].filledFull, true);
  assert.equal(gaps[0].filledHalf, true);
  assert.equal(gaps[0].fillPct, 1);
});

test("fill tracking: partial coverage of the zone counts exactly", () => {
  // zone = [101, 103] (2 pt). One later bar covers [101, 102] → 50%.
  const bars = [bar("09:30", 100, 101), bar("09:31", 103, 104), bar("09:32", 101, 102)];
  const gaps = gapInventory(bars);
  assert.equal(gaps[0].fillPct, 0.5);
  assert.ok(gaps[0].filledHalf); // Naso's own 50% threshold
  assert.ok(!gaps[0].filledFull);
});

test("disjoint partial fills merge instead of double-counting", () => {
  // zone = [101, 105] (4 pt). Bars cover [101,102] and [103,104] → 2 pt total.
  const bars = [bar("09:30", 100, 101), bar("09:31", 105, 106), bar("09:32", 101, 102), bar("09:33", 103, 104)];
  const gaps = gapInventory(bars);
  assert.equal(gaps[0].fillPct, 0.5);
});

/* ---------------- chips ---------------- */

test("an unfilled gap strictly inside the long path prints GAP IN PATH", () => {
  const bars = [
    bar("09:30", 100, 101),
    bar("09:31", 103, 104), // gap up [101,103], unfilled
    bar("09:32", 104, 105),
  ];
  const c = gapChips(bars, { entry: 100.5, target: 110, dir: "long" });
  assert.ok(c.labels.includes("GAP IN PATH"));
  assert.equal(c.features.gapInPath, true);
  assert.equal(c.features.gapInPathPts, 0.5); // entry → gap bottom 101
  assert.equal(c.features.nearestUnfilledGap, 0.5);
  assert.equal(c.features.sessionGaps, 1);
});

test("an entry sitting inside an unfilled zone counts at distance 0", () => {
  const bars = [
    bar("09:30", 100, 101),
    bar("09:31", 103, 104), // gap up [101,103]
    bar("09:32", 104, 105),
  ];
  const c = gapChips(bars, { entry: 101.5, target: 110, dir: "long" });
  assert.ok(c.labels.includes("GAP IN PATH"));
  assert.equal(c.features.gapInPathPts, 0);
  assert.equal(c.features.nearestUnfilledGap, 0);
});

test("a gap behind the entry is not in the path", () => {
  const bars = [
    bar("09:30", 100, 101),
    bar("09:31", 103, 104), // gap up [101,103]
    bar("09:32", 104, 105),
  ];
  const c = gapChips(bars, { entry: 105, target: 110, dir: "long" });
  assert.equal(c.features.gapInPath, undefined);
  assert.equal(c.features.nearestUnfilledGap, null); // no unfilled gap on the trade side
  assert.deepEqual(c.labels, []);
});

test("short path: an unfilled gap between entry and target counts", () => {
  const bars = [
    bar("09:30", 110, 111),
    bar("09:31", 106, 107), // gap down [107,110]
    bar("09:32", 105, 106),
  ];
  const c = gapChips(bars, { entry: 111, target: 100, dir: "short" });
  assert.ok(c.labels.includes("GAP IN PATH"));
  assert.equal(c.features.gapInPathPts, 1); // entry → gap top 110
});

test("a gap filled ≥50% no longer blocks the path but feeds the regime chip", () => {
  const bars = [
    bar("09:30", 100, 101),
    bar("09:31", 103, 104), // gap up [101,103]
    bar("09:32", 101, 103), // fully retrades the zone (overlaps both edges — no cascade)
  ];
  const c = gapChips(bars, { entry: 101.5, target: 110, dir: "long" });
  assert.equal(c.features.gapInPath, undefined);
  assert.equal(c.features.recentGapFill, true);
  assert.ok(c.labels.includes("GAP FILLED 30m"));
  assert.equal(c.features.sessionGaps, 1);
});

test("old fills do not light the recent chip", () => {
  const bars: GapBar[] = [bar("09:00", 100, 101), bar("09:01", 103, 104), bar("09:02", 101, 102.5)];
  for (let i = 0; i < 40; i++) bars.push(bar(`10:${String(i).padStart(2, "0")}`, 104, 105)); // 40 quiet bars
  const c = gapChips(bars, { entry: 104.5, target: 110, dir: "long" });
  assert.equal(c.features.recentGapFill, undefined);
});

test("no gaps at all → empty chips with a zero count", () => {
  const c = gapChips([bar("09:30", 100, 101), bar("09:31", 100.5, 101.5)], { entry: 101, target: 110, dir: "long" });
  assert.deepEqual(c.labels, []);
  assert.equal(c.features.sessionGaps, 0);
  assert.equal(c.features.nearestUnfilledGap, null);
});
