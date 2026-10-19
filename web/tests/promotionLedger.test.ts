/* Unit tests for the promotion ledger (lib/promotionLedger.ts).
 * Run: node --import ./tests/ts-loader.mjs --test tests/promotionLedger.test.ts */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statusFor, HISTORICAL_RUNS, type PromotionRunRow } from "../lib/promotionLedger";

const run = (over: Partial<PromotionRunRow> & { id: number; script: string }): PromotionRunRow => ({
  run_at: "2026-10-17T00:00:00Z",
  cli: "",
  sha: "abc",
  family: "huge_bar_expansion",
  gate: "side_veto",
  value: null,
  verdict: "rejected",
  reasons: ["x"],
  note: "",
  applied: false,
  ...over,
});

describe("statusFor", () => {
  it("research when a study has no runs", () => {
    const s = statusFor([], "scripts/momentumStudy.ts");
    assert.equal(s.status, "research");
    assert.equal(s.run, null);
  });

  it("promoted when the latest run passed", () => {
    const s = statusFor(
      [run({ id: 1, script: "scripts/countFracGateStudy.ts", verdict: "rejected" }), run({ id: 2, script: "scripts/countFracGateStudy.ts", verdict: "passed", run_at: "2026-10-17T01:00:00Z" })],
      "scripts/countFracGateStudy.ts",
    );
    assert.equal(s.status, "promoted");
    assert.equal(s.run?.id, 2);
  });

  it("rejected with the latest reasons, newer run supersedes", () => {
    const s = statusFor(
      [run({ id: 1, script: "scripts/sideVetoStudy.ts", verdict: "passed", run_at: "2026-10-16T10:00:00Z" }), run({ id: 2, script: "scripts/sideVetoStudy.ts", verdict: "rejected", reasons: ["cosmetic"] })],
      "scripts/sideVetoStudy.ts",
    );
    assert.equal(s.status, "rejected");
    assert.deepEqual(s.run?.reasons, ["cosmetic"]);
  });

  it("historical seeds cover the session's three verdicts", () => {
    const scripts = HISTORICAL_RUNS.map((r) => r.script);
    assert.ok(scripts.includes("scripts/sideVetoStudy.ts"));
    assert.ok(scripts.includes("scripts/countFracGateStudy.ts"));
    assert.ok(scripts.includes("scripts/newsWindowStudy.ts"));
    const promoted = HISTORICAL_RUNS.filter((r) => r.verdict === "passed");
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].gate, "min_count_frac");
  });
});
