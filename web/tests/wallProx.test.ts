/* Wall-proximity chip tests — pure function of an OptionsRead + ticket
 * prices, no network. Rules re-derived from the docstrings in
 * lib/wallProx.ts and the OptionsRead contract in lib/options.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wallProxChips } from "../lib/wallProx";
import type { OptionsRead } from "../lib/options";

/** minimal NQ-mapped options read with explicit walls (total only —
 *  wallsFromRead falls back to the total walls when `near` is absent) */
function read(flipNq: number | null, callWallNq: number | null, putWallNq: number | null): OptionsRead {
  return {
    regime: "chop",
    note: "test",
    flipNq,
    callWallNq,
    putWallNq,
    near: null,
    monthly: null,
    far: null,
    nqSpot: 21_800,
    qqqSpot: 545,
    netGexUsd: 0,
    aboveFlip: true,
    dataOk: true,
  };
}

test("long: nearest wall ahead is logged with distance", () => {
  const c = wallProxChips(read(21_900, 21_950, 21_700), { entry: 21_800, target: 21_820, dir: "long" });
  assert.equal(c.features.wallAhead, "flip"); // 21,900 is the nearest above
  assert.equal(c.features.wallDistPts, 100);
  assert.equal(c.features.wallInPath, false); // 100 pt away, target only 20
  assert.deepEqual(c.labels, []);
});

test("long: a wall between entry and target prints WALL IN PATH", () => {
  const c = wallProxChips(read(21_900, 21_815, 21_700), { entry: 21_800, target: 21_850, dir: "long" });
  assert.equal(c.features.wallAhead, "call"); // 21,815 nearer than flip 21,900
  assert.equal(c.features.wallDistPts, 15);
  assert.equal(c.features.wallInPath, true); // 21,815 ≤ target 21,850
  assert.deepEqual(c.labels, ["WALL IN PATH"]);
});

test("long: a near wall beyond the target prints the distance chip", () => {
  const c = wallProxChips(read(21_900, 21_815, 21_700), { entry: 21_800, target: 21_808, dir: "long" });
  assert.equal(c.features.wallInPath, false); // 21,815 > target
  assert.deepEqual(c.labels, ["WALL 15PT"]);
});

test("short: walls below the entry are the relevant side", () => {
  const c = wallProxChips(read(21_900, 21_950, 21_700), { entry: 21_800, target: 21_740, dir: "short" });
  assert.equal(c.features.wallAhead, "put"); // 21,700
  assert.equal(c.features.wallDistPts, 100);
  assert.equal(c.features.wallInPath, false);
});

test("short: a wall between entry and target prints WALL IN PATH", () => {
  const c = wallProxChips(read(21_900, 21_950, 21_785), { entry: 21_800, target: 21_740, dir: "short" });
  assert.equal(c.features.wallInPath, true); // 21,785 ≥ target 21,740
  assert.deepEqual(c.labels, ["WALL IN PATH"]);
});

test("long already through the call wall prints PAST WALL", () => {
  const c = wallProxChips(read(21_750, 21_700, 21_600), { entry: 21_800, target: 21_900, dir: "long" });
  assert.equal(c.features.pastWall, true); // call wall 21,700 below entry
  assert.equal(c.features.wallAhead, undefined); // nothing above the entry
  assert.deepEqual(c.labels, ["PAST WALL"]);
});

test("no options data degrades gracefully to empty chips", () => {
  const c = wallProxChips(null, { entry: 21_800, target: 21_850, dir: "long" });
  assert.deepEqual(c.labels, []);
  assert.deepEqual(c.features, {});
  const noWalls = wallProxChips(read(null, null, null), { entry: 21_800, target: 21_850, dir: "long" });
  assert.deepEqual(noWalls.labels, []);
  assert.deepEqual(noWalls.features, {});
  const bad = { ...read(21_900, 21_950, 21_700), dataOk: false } as OptionsRead;
  assert.deepEqual(wallProxChips(bad, { entry: 21_800, target: 21_850, dir: "long" }).labels, []);
});

test("non-finite ticket prices degrade gracefully", () => {
  const c = wallProxChips(read(21_900, 21_950, 21_700), { entry: NaN, target: 21_850, dir: "long" });
  assert.deepEqual(c.labels, []);
  assert.deepEqual(c.features, {});
});
