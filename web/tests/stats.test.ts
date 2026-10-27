import { test } from "node:test";
import assert from "node:assert/strict";
import { median, upperMedian } from "../lib/stats";

test("upperMedian: detector convention s[floor(n/2)]", () => {
  assert.equal(upperMedian([]), 0);
  assert.equal(upperMedian([5]), 5);
  assert.equal(upperMedian([3, 1, 2]), 2);
  assert.equal(upperMedian([4, 1, 3, 2]), 3); // upper middle, not 2.5
});

test("median: textbook median (mean of the two middle values)", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("neither mutates its input", () => {
  const a = [3, 1, 2];
  upperMedian(a);
  median(a);
  assert.deepEqual(a, [3, 1, 2]);
});
