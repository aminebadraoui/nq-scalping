/* Unit tests for the RTH limit-entry redesign params (lib/signalFeed.ts
 * rthLimitParams). The redesign itself is validated by
 * scripts/rthLimitValidation.ts (train/OOS/year/cost ladder). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rthLimitParams } from "../lib/signalFeed";

test("rthLimitParams is OFF by default with the validated knobs", () => {
  const p = rthLimitParams({});
  assert.equal(p.enabled, false);
  assert.equal(p.stopMult, 0.5);
  assert.equal(p.targetR, 2.5);
  assert.equal(p.ttlMs, 9 * 60_000);
});

test("rthLimitParams enables via RTH_LIMIT_ENTRIES=1", () => {
  const p = rthLimitParams({ RTH_LIMIT_ENTRIES: "1" });
  assert.equal(p.enabled, true);
});

test("rthLimitParams applies env overrides", () => {
  const p = rthLimitParams({
    RTH_LIMIT_ENTRIES: "1",
    RTH_LIMIT_STOP_MULT: "0.6",
    RTH_LIMIT_TARGET_R: "2",
    RTH_LIMIT_TTL_MS: "300000",
  });
  assert.equal(p.enabled, true);
  assert.equal(p.stopMult, 0.6);
  assert.equal(p.targetR, 2);
  assert.equal(p.ttlMs, 300000);
});

test("rthLimitParams falls back on garbage values", () => {
  const p = rthLimitParams({
    RTH_LIMIT_ENTRIES: "1",
    RTH_LIMIT_STOP_MULT: "abc",
    RTH_LIMIT_TARGET_R: "-3",
    RTH_LIMIT_TTL_MS: "0",
  });
  assert.equal(p.enabled, true);
  assert.equal(p.stopMult, 0.5);
  assert.equal(p.targetR, 2.5);
  assert.equal(p.ttlMs, 9 * 60_000);
});
