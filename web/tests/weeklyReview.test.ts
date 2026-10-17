/* Unit tests for the weekly-review experiment helpers (lib/weeklyReview.ts):
 * the LLM payload parser + the hypothesis sanitizer — every rule fails closed. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLlmPayload, sanitizeHypothesis, catalogPromptText, STUDY_CATALOG, parseBudgetEnv, budgetFor, DEFAULT_STUDY_BUDGETS, buildAccountRollup } from "../lib/weeklyReview";

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

describe("buildAccountRollup", () => {
  it("groups matched trades per account and buckets unknown accounts", () => {
    const rolls = buildAccountRollup(
      [
        { account: "DEMO2323960", result: "win", grossUsd: 240, commissions: 10.4, netUsd: 229.6 },
        { account: "DEMO2323960", result: "loss", grossUsd: -87.5, commissions: 6.5, netUsd: -94 },
        { account: "MFFUEVREOD706880007", result: "win", grossUsd: 92, commissions: 15.2, netUsd: 76.8 },
        { account: "", result: "loss", grossUsd: -70, commissions: 13.3, netUsd: -83.3 },
      ],
      [],
    );
    assert.equal(rolls.length, 3);
    const demo = rolls.find((r) => r.account === "DEMO2323960")!;
    assert.equal(demo.matched.n, 2);
    assert.equal(demo.matched.wins, 1);
    assert.equal(demo.matched.netUsd, 135.6);
    const unknown = rolls.find((r) => r.account === "unknown")!;
    assert.equal(unknown.matched.n, 1);
  });

  it("dedupes double nightly reconcile runs and keeps the max realized", () => {
    const rolls = buildAccountRollup(
      [],
      [
        { account: "DEMO2323960", window_start: "2026-10-16", window_end: "2026-10-17", manual_fills: 4, manual_gross_usd: -83, account_net: 50217.2, account_realized: 217.2 },
        { account: "DEMO2323960", window_start: "2026-10-16", window_end: "2026-10-17", manual_fills: 4, manual_gross_usd: -83, account_net: 50217.2, account_realized: 0 },
        { account: "MFFUEVREOD706880007", window_start: "2026-10-13", window_end: "2026-10-14", manual_fills: 40, manual_gross_usd: 2143.67, account_net: null, account_realized: 777.8 },
      ],
    );
    assert.equal(rolls.length, 2);
    const demo = rolls.find((r) => r.account === "DEMO2323960")!;
    assert.equal(demo.manual.fills, 4); // not 8 — the duplicate window is deduped
    assert.equal(demo.manual.grossUsd, -83);
    assert.equal(demo.realizedUsd, 217.2); // the post-reset 0 doesn't erase it
    assert.equal(demo.netLiq, 50217.2);
    const mff = rolls.find((r) => r.account === "MFFUEVREOD706880007")!;
    assert.equal(mff.realizedUsd, 777.8);
  });

  it("merges trades and runs into one row per account", () => {
    const rolls = buildAccountRollup(
      [{ account: "DEMO2323960", result: "win", grossUsd: 240, commissions: 10.4, netUsd: 229.6 }],
      [{ account: "DEMO2323960", window_start: "w1", window_end: "w2", manual_fills: 4, manual_gross_usd: -83, account_net: 50000, account_realized: 217.2 }],
    );
    assert.equal(rolls.length, 1);
    assert.equal(rolls[0].matched.n, 1);
    assert.equal(rolls[0].manual.fills, 4);
    assert.equal(rolls[0].realizedUsd, 217.2);
  });
});
