import { test } from "node:test";
import assert from "node:assert/strict";
import { fisherExact, mannWhitneyP, cmhP, bhFdr, chi2cdf, normalCdf } from "../lib/patternStats";

test("fisherExact matches the classic tea-tasting table (3,1;1,3 → 0.4857)", () => {
  const p = fisherExact(3, 1, 1, 3);
  assert.ok(Math.abs(p - 0.4857) < 0.001, `p=${p}`);
});

test("fisherExact: a perfectly separated table is vanishingly small", () => {
  const p = fisherExact(10, 0, 0, 10);
  assert.ok(p < 2e-5, `p=${p}`);
});

test("fisherExact: identical rows give p ≈ 1", () => {
  const p = fisherExact(5, 5, 5, 5);
  assert.ok(p > 0.99, `p=${p}`);
});

test("mannWhitneyP: separated groups → tiny p; identical → p=1", () => {
  const p = mannWhitneyP([31, 32, 33, 34, 35, 36, 37, 38, 39, 40], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(p < 0.001, `p=${p}`);
  const same = mannWhitneyP([5, 6, 7], [5, 6, 7]);
  assert.ok(Math.abs(same - 1) < 1e-9, `p=${same}`);
});

test("mannWhitneyP handles ties without exploding", () => {
  const p = mannWhitneyP([1, 1, 2, 2, 3], [1, 2, 2, 3, 3]);
  assert.ok(p > 0 && p <= 1, `p=${p}`);
});

test("cmhP: consistent direction across strata → small p; reversed strata → large p", () => {
  // both strata favor present
  const consistent = cmhP([
    { a: 15, b: 5, c: 5, d: 15 },
    { a: 12, b: 8, c: 4, d: 16 },
  ]);
  assert.ok(consistent < 0.001, `p=${consistent}`);
  // one stratum favors present, the other favors absent equally
  const reversed = cmhP([
    { a: 15, b: 5, c: 5, d: 15 },
    { a: 5, b: 15, c: 15, d: 5 },
  ]);
  assert.ok(reversed > 0.9, `p=${reversed}`);
});

test("bhFdr: the classic step-up example", () => {
  const q = bhFdr([0.01, 0.02, 0.5]);
  assert.deepEqual(q.map((x) => Math.round(x * 100) / 100), [0.03, 0.03, 0.5]);
});

test("chi2cdf and normalCdf sanity", () => {
  assert.ok(Math.abs(chi2cdf(3.841, 1) - 0.95) < 0.001);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6, "polynomial approx, not exact at 0");
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 0.001);
});
