/* Unit tests for the promotion gate (lib/promotionGate.ts).
 * Run: node --import ./tests/ts-loader.mjs --test tests/promotionGate.test.ts */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPromotion, buildReport, cohortOf, UNDECLARED_STACK_MARKER, type StudyReport } from "../lib/promotionGate";

/* ---------------- fixture: a contract-passing report ---------------- */

const passing = (): StudyReport =>
  buildReport({
    script: "scripts/momentumStudy.ts",
    cli: "scripts/momentumStudy.ts --mode momentum --sweep",
    sha: "deadbeef",
    splitDate: "2026-01-01",
    stack: "signals *_PROD (registry) · gates default set · risk challengeRules+guardCore · fill 0.5pt/close-entry",
    family: "momentum_flush",
    gate: "hour_veto",
    value: { hours: [16] },
    note: "measured hour veto",
    baseline: {
      ...cohortOf({ n: 1000, wr: 75, wrCi: [72, 78], pf: 2.5, expPts: 2.2, expR: 0.4, sessions: 600 }),
      train: cohortOf({ n: 700, wr: 74, wrCi: [70, 77], pf: 2.4, expPts: 2.1, expR: 0.39, sessions: 420 }),
      test: cohortOf({ n: 300, wr: 77, wrCi: [72, 81], pf: 2.7, expPts: 2.4, expR: 0.42, sessions: 180 }),
    },
    candidate: {
      ...cohortOf({ n: 800, wr: 78, wrCi: [75, 81], pf: 2.9, expPts: 2.6, expR: 0.46, sessions: 590 }),
      train: cohortOf({ n: 550, wr: 77, wrCi: [73, 80], pf: 2.8, expPts: 2.5, expR: 0.45, sessions: 415 }),
      test: cohortOf({ n: 250, wr: 80, wrCi: [74, 85], pf: 3.1, expPts: 2.9, expR: 0.5, sessions: 175 }),
    },
    vetoedSharePct: 20,
    vetoed: {
      ...cohortOf({ n: 200, wr: 62, wrCi: [55, 68], pf: 1.3, expPts: 0.4, expR: 0.1, sessions: 400 }),
      test: cohortOf({ n: 50, wr: 60, wrCi: [46, 72], pf: 1.2, expPts: 0.2, expR: 0.08, sessions: 170 }),
    },
    viability: { evalPass: true, fundedPass: true, evalTestPass: true, fundedTestPass: true },
    grid: { variants: 4, dsr: 0.97, pbo: 0.1 },
  });

describe("checkPromotion", () => {
  it("passes a fully compliant report", () => {
    const v = checkPromotion(passing());
    assert.equal(v.pass, true, v.reasons.join("; "));
    assert.deepEqual(v.reasons, []);
  });

  it("rejects a non-suppressive gate", () => {
    const r = passing();
    (r as { gate: string }).gate = "targetR";
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("not auto-promotable")));
  });

  it("rejects a script outside the gate allowlist", () => {
    const r = passing();
    r.script = "scripts/someScratch.ts";
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("allowlist")));
  });

  it("rejects an undeclared stack", () => {
    const r = passing();
    r.stack = `signals *_PROD — ${UNDECLARED_STACK_MARKER}`;
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("Stack")));
  });

  it("rejects a candidate below the sample floor", () => {
    const r = passing();
    r.candidate = { ...r.candidate, n: 90 };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("candidate cohort")));
  });

  it("rejects a thin test cohort", () => {
    const r = passing();
    r.candidate.test = { ...(r.candidate.test as NonNullable<typeof r.candidate.test>), n: 40 };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("test cohort")));
  });

  it("rejects when the test WR lower CI does not clear 50%", () => {
    const r = passing();
    r.candidate.test = { ...(r.candidate.test as NonNullable<typeof r.candidate.test>), wrCi: [48, 60] };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("50%")));
  });

  it("rejects when the vetoed cohort is not worse than baseline", () => {
    const r = passing();
    r.vetoed = { ...(r.vetoed as NonNullable<typeof r.vetoed>), test: { n: 50, wr: 85, wrCi: [74, 92], pf: 2.0, expPts: 2.0, expR: 0.4, sessions: 170 } };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("below-average")));
  });

  it("rejects a failed prop sim", () => {
    const r = passing();
    r.viability = { evalPass: true, fundedPass: true, evalTestPass: false, fundedTestPass: false };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("prop sim")));
  });

  it("rejects a grid without DSR/PBO", () => {
    const r = passing();
    r.grid = { variants: 4 };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("DSR + PBO")));
  });

  it("rejects a grid with PBO over the bar", () => {
    const r = passing();
    r.grid = { variants: 4, dsr: 0.97, pbo: 0.5 };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("PBO")));
  });

  it("rejects a grid with weak DSR", () => {
    const r = passing();
    r.grid = { variants: 4, dsr: 0.8, pbo: 0.1 };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("DSR")));
  });

  it("rejects a veto over the 30% budget", () => {
    const r = passing();
    r.vetoedSharePct = 45;
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("budget")));
  });

  it("passes without viability/grid/veto data (optional blocks)", () => {
    const r = passing();
    r.viability = undefined;
    r.grid = undefined;
    r.vetoed = undefined;
    r.vetoedSharePct = undefined;
    const v = checkPromotion(r);
    assert.equal(v.pass, true, v.reasons.join("; "));
  });

  it("promotes side_veto via the sideVetoStudy script", () => {
    const r = passing();
    r.script = "scripts/sideVetoStudy.ts";
    r.gate = "side_veto";
    r.value = { side: "short", hours: [8] };
    const v = checkPromotion(r);
    assert.equal(v.pass, true, v.reasons.join("; "));
  });

  it("rejects a vetoed test cohort under the 30-trade floor", () => {
    const r = passing();
    r.vetoed = { ...(r.vetoed as NonNullable<typeof r.vetoed>), test: { n: 12, wr: 60, wrCi: [30, 85], pf: 1.2, expPts: 0.2, expR: 0.08, sessions: 40 } };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("too thin")));
  });

  it("rejects a cosmetic veto — removed trades still pay their own costs", () => {
    const r = passing();
    r.vetoed = {
      ...(r.vetoed as NonNullable<typeof r.vetoed>),
      test: { n: 50, wr: 68, wrCi: [55, 79], pf: 1.6, expPts: 1.1, expR: 0.2, sessions: 170 },
    };
    const v = checkPromotion(r);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((m) => m.includes("cosmetic")));
  });

  it("accepts a veto whose test cohort cannot pay costs despite a CI above 50 (exp ≤ 0.25)", () => {
    const r = passing();
    r.vetoed = {
      ...(r.vetoed as NonNullable<typeof r.vetoed>),
      test: { n: 50, wr: 63, wrCi: [51, 74], pf: 1.1, expPts: 0.2, expR: 0.05, sessions: 170 },
    };
    const v = checkPromotion(r);
    assert.equal(v.pass, true, v.reasons.join("; "));
  });
});
