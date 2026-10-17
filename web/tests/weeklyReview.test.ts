/* Unit tests for the weekly-review experiment helpers (lib/weeklyReview.ts):
 * the LLM payload parser + the hypothesis sanitizer — every rule fails closed. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLlmPayload, sanitizeHypothesis, catalogPromptText, STUDY_CATALOG, parseBudgetEnv, budgetFor, DEFAULT_STUDY_BUDGETS } from "../lib/weeklyReview";

describe("sanitizeHypothesis", () => {
  it("accepts a valid catalog hypothesis", () => {
    const h = sanitizeHypothesis({
      title: "re-test the count-frac gate at θ=0.70",
      study: "scripts/countFracGateStudy.ts",
      args: ["--offline", "--theta", "0.70", "--family", "momentum_flush"],
      rationale: "the flush family was never measured at 0.70",
    });
    assert.ok(h);
    assert.equal(h!.title, "re-test the count-frac gate at θ=0.70");
    assert.equal(h!.args.length, 5);
  });

  it("rejects a study outside the catalog", () => {
    assert.equal(sanitizeHypothesis({ title: "x", study: "scripts/rm-rf.ts", args: [] }), null);
  });

  it("rejects forbidden flags the job manages itself", () => {
    for (const bad of ["--report-json", "--apply", "--now", "--warm", "--sweep-out", "--dump"]) {
      assert.equal(
        sanitizeHypothesis({ title: "x", study: "scripts/countFracGateStudy.ts", args: ["--offline", bad] }),
        null,
        `should reject ${bad}`,
      );
    }
  });

  it("rejects non-string args, newlines, and oversized arg lists", () => {
    assert.equal(sanitizeHypothesis({ title: "x", study: "scripts/hourExpectancyStudy.ts", args: [42] }), null);
    assert.equal(sanitizeHypothesis({ title: "x", study: "scripts/hourExpectancyStudy.ts", args: ["a\nb"] }), null);
    const many = Array.from({ length: 11 }, (_, i) => `--f${i}`);
    assert.equal(sanitizeHypothesis({ title: "x", study: "scripts/hourExpectancyStudy.ts", args: many }), null);
  });

  it("allows no args (study defaults) and a missing rationale", () => {
    const h = sanitizeHypothesis({ title: "hour cells", study: "scripts/hourExpectancyStudy.ts" });
    assert.ok(h);
    assert.deepEqual(h!.args, []);
    assert.equal(h!.rationale, "");
  });

  it("rejects a missing or oversized title", () => {
    assert.equal(sanitizeHypothesis({ study: "scripts/hourExpectancyStudy.ts", args: [] }), null);
    assert.equal(sanitizeHypothesis({ title: "x".repeat(141), study: "scripts/hourExpectancyStudy.ts", args: [] }), null);
  });
});

describe("parseLlmPayload", () => {
  it("treats plain prose as narrative-only", () => {
    const p = parseLlmPayload("# Week review\nSome prose.");
    assert.equal(p.narrative, "# Week review\nSome prose.");
    assert.deepEqual(p.hypotheses, []);
  });

  it("parses a fenced JSON payload and drops invalid hypotheses", () => {
    const p = parseLlmPayload(
      '```json\n{"narrative":"Week story","hypotheses":[' +
        '{"title":"a","study":"scripts/sideVetoStudy.ts","args":["--offline"],"rationale":"r"},' +
        '{"title":"b","study":"scripts/evil.ts","args":[]},' +
        '{"title":"c","study":"scripts/countFracGateStudy.ts","args":["--apply"]}' +
        "]}\n```",
    );
    assert.equal(p.narrative, "Week story");
    assert.equal(p.hypotheses.length, 1);
    assert.equal(p.hypotheses[0].title, "a");
  });

  it("parses a bare JSON object even with prose around it", () => {
    const p = parseLlmPayload('here you go: {"narrative":"Week story","hypotheses":[]} thanks!');
    assert.equal(p.narrative, "Week story");
    assert.deepEqual(p.hypotheses, []);
  });

  it("falls back to prose on invalid JSON", () => {
    const p = parseLlmPayload('{"narrative": "unterminated');
    assert.equal(p.narrative, '{"narrative": "unterminated');
    assert.deepEqual(p.hypotheses, []);
  });

  it("uses the raw text as narrative when the field is missing", () => {
    const p = parseLlmPayload('{"hypotheses":[]}');
    assert.equal(p.narrative, '{"hypotheses":[]}');
    assert.deepEqual(p.hypotheses, []);
  });
});

describe("catalogPromptText", () => {
  it("lists every catalog study with its gates", () => {
    const t = catalogPromptText();
    for (const c of STUDY_CATALOG) {
      assert.ok(t.includes(c.study), `missing ${c.study}`);
      assert.ok(t.includes(c.gates), `missing gates for ${c.study}`);
    }
  });
});

describe("study budgets (Phase 4)", () => {
  it("returns the warm-cache defaults", () => {
    assert.equal(parseBudgetEnv("").countFracGateStudy, 20);
    assert.equal(parseBudgetEnv("").sideVetoStudy, 15);
  });

  it("merges valid overrides and ignores junk", () => {
    const b = parseBudgetEnv("countFracGateStudy=30,sideVetoStudy=2.5,bad,=10,other=-5,big=99,empty=0");
    assert.equal(b.countFracGateStudy, 30);
    assert.equal(b.sideVetoStudy, 2.5);
    assert.equal(b.other, undefined);
    assert.equal(b.big, undefined); // > 60 rejected
    assert.equal(b.empty, undefined); // 0 rejected
  });

  it("resolves a budget from a script path", () => {
    const b = parseBudgetEnv("");
    assert.equal(budgetFor(b, "scripts/countFracGateStudy.ts"), 20);
    assert.equal(budgetFor(b, "scripts/unknown.ts"), null);
    assert.equal(budgetFor(b, "countFracGateStudy"), 20);
    assert.equal(DEFAULT_STUDY_BUDGETS.hourExpectancyStudy, 15);
  });
});
