/* Round-number chip tests — pure price math, no network. Rules re-derived
 * from the docstrings in lib/roundNumbers.ts so a regression in the
 * implementation cannot make a test pass by definition. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nearestRound,
  distToRound,
  atRound,
  roundBetween,
  roundNumberChips,
} from "../lib/roundNumbers";

/* ---------------- grid helpers ---------------- */

test("nearestRound snaps to the nearest 50-handle", () => {
  assert.equal(nearestRound(21_800), 21_800);
  assert.equal(nearestRound(21_810), 21_800);
  assert.equal(nearestRound(21_824.75), 21_800);
  assert.equal(nearestRound(21_825), 21_850); // ties round up
  assert.equal(nearestRound(21_874.5), 21_850);
  assert.equal(nearestRound(21_876), 21_900);
});

test("distToRound is signed (positive above, negative below)", () => {
  assert.equal(distToRound(21_810), 10);
  assert.equal(distToRound(21_790), -10);
  assert.equal(distToRound(21_800), 0);
});

test("atRound default tolerance is 1 pt", () => {
  assert.ok(atRound(21_800.5));
  assert.ok(atRound(21_799.25));
  assert.ok(!atRound(21_801.25));
  assert.ok(!atRound(21_798.5));
});

test("roundBetween finds a handle strictly inside the path", () => {
  assert.ok(roundBetween(21_790, 21_860)); // 21,800 + 21,850 inside
  assert.ok(roundBetween(21_795, 21_805)); // 21,800 inside
  assert.ok(!roundBetween(21_800, 21_810)); // nothing between 800 and 810
  assert.ok(!roundBetween(21_790, 21_800)); // 21,800 is the endpoint, not inside
  assert.ok(!roundBetween(21_800, 21_800));
  assert.ok(roundBetween(21_860, 21_790)); // order-insensitive
});

/* ---------------- chips ---------------- */

test("stop parked on a handle prints STOP @ROUND and logs the features", () => {
  const c = roundNumberChips({ entry: 21_812, stop: 21_800, target: 21_822, dir: "long" });
  assert.deepEqual(c.labels, ["STOP @ROUND"]);
  assert.equal(c.features.stopAtRound, true);
  assert.equal(c.features.stopToRound50, 0);
  assert.equal(c.features.entryToRound50, 12);
  assert.equal(c.features.targetToRound50, 22);
  assert.equal(c.features.targetCrossRound, undefined);
});

test("a handle between entry and target prints TARGET CROSSES 50", () => {
  const c = roundNumberChips({ entry: 21_790, stop: 21_775, target: 21_830, dir: "long" });
  assert.deepEqual(c.labels, ["TARGET CROSSES 50"]);
  assert.equal(c.features.targetCrossRound, true);
  assert.equal(c.features.stopAtRound, undefined); // 21,775 is 25 off
});

test("short trade: path goes down, same geometry", () => {
  const c = roundNumberChips({ entry: 21_810, stop: 21_830, target: 21_765, dir: "short" });
  assert.deepEqual(c.labels, ["TARGET CROSSES 50"]); // 21,800 inside
  assert.equal(c.features.targetCrossRound, true);
});

test("entry on a handle with no path crossing prints ENTRY @ROUND", () => {
  const c = roundNumberChips({ entry: 21_800, stop: 21_792, target: 21_812, dir: "long" });
  assert.deepEqual(c.labels, ["ENTRY @ROUND"]);
  assert.equal(c.features.entryAtRound, true);
  assert.equal(c.features.targetCrossRound, undefined);
});

test("a stop AT a handle AND a target crossing it prints both", () => {
  const c = roundNumberChips({ entry: 21_812, stop: 21_800, target: 21_880, dir: "long" });
  assert.deepEqual(c.labels, ["STOP @ROUND", "TARGET CROSSES 50"]);
});

test("an ordinary ticket prints no labels but always logs distances", () => {
  const c = roundNumberChips({ entry: 21_823.5, stop: 21_810.25, target: 21_838.75, dir: "long" });
  assert.deepEqual(c.labels, []);
  assert.equal(c.features.entryToRound50, 23.5); // nearest handle 21,800
  assert.equal(c.features.stopToRound50, 10.25);
  assert.equal(c.features.targetToRound50, -11.25); // nearest handle 21,850
  assert.equal(c.features.stopAtRound, undefined);
  assert.equal(c.features.targetCrossRound, undefined);
});

test("non-finite prices degrade to empty chips", () => {
  const c = roundNumberChips({ entry: NaN, stop: 21_800, target: 21_820, dir: "long" });
  assert.deepEqual(c.labels, []);
  assert.deepEqual(c.features, {});
});

test("custom step sizes work for the raw helpers", () => {
  assert.equal(nearestRound(105, 100), 100);
  assert.ok(atRound(100.5, 100, 1));
  assert.ok(roundBetween(95, 105, 100));
});
