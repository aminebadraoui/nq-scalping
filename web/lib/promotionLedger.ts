/* ------------------------------------------------------------------ *
 * Promotion ledger — the single source of truth the /promotions
 * surface renders: every promotion-contract run (pass AND reject),
 * its verdict + reasons, mapped onto the committed study catalog.
 *
 * Pure + unit-tested (tests/promotionLedger.test.ts). The DB rows live
 * in `promotion_runs` (web/db/schema.sql); scripts/promoteFromBacktest.ts
 * records every verdict and scripts/seedPromotionLedger.ts backfills
 * the historical runs once (idempotent).
 * ------------------------------------------------------------------ */

export type PromotionRunRow = {
  id: number;
  run_at: string;
  script: string;
  cli: string;
  sha: string;
  family: string;
  gate: string;
  value: unknown;
  verdict: "passed" | "rejected";
  reasons: string[];
  note: string;
  applied: boolean;
};

export type StudyPromotionStatus = {
  status: "promoted" | "rejected" | "research";
  run: PromotionRunRow | null;
};

/** the latest run per study script wins — a newer verdict supersedes */
export function statusFor(runs: PromotionRunRow[], script: string): StudyPromotionStatus {
  const mine = runs
    .filter((r) => r.script === script)
    .sort((a, b) => b.run_at.localeCompare(a.run_at) || b.id - a.id);
  const run = mine[0] ?? null;
  return {
    status: run ? (run.verdict === "passed" ? "promoted" : "rejected") : "research",
    run,
  };
}

/** historical runs from this session (2026-10-16/17) — seeded once by
 *  scripts/seedPromotionLedger.ts so the surface is accurate from day one */
export const HISTORICAL_RUNS: Omit<PromotionRunRow, "id" | "run_at">[] = [
  {
    script: "scripts/sideVetoStudy.ts",
    cli: "scripts/sideVetoStudy.ts --family momentum_expansion --veto {\"side\":\"short\",\"hours\":[21]} --report-json /tmp/exp-short21.report.json --offline",
    sha: "7718c0e",
    family: "momentum_expansion",
    gate: "side_veto",
    value: { side: "short", hours: [21] },
    verdict: "rejected",
    reasons: [
      "vetoed cohort test WR 77.4% ≥ baseline test WR 75.4% — the gate does not remove below-average trades",
      "vetoed cohort test exp 3.44 pts > 0.25 with WR CI lower 64.5% ≥ 50 — the removed trades still pay their own costs; the gate is cosmetic",
    ],
    note: "side×hour scans of all three families: no cell has negative expectancy",
    applied: false,
  },
  {
    script: "scripts/countFracGateStudy.ts",
    cli: "scripts/countFracGateStudy.ts --family momentum_expansion --theta 0.60 --report-json /tmp/exp-cf060.report.json --offline",
    sha: "7718c0e",
    family: "momentum_expansion",
    gate: "min_count_frac",
    value: { min: 0.6, on: "count" },
    verdict: "passed",
    reasons: [],
    note: "count-frac >= 0.60 (countFracGateStudy + validate_sweep DSR 1.000 PBO 0.108) — insight #54 applied 2026-10-17",
    applied: true,
  },
  {
    script: "scripts/newsWindowStudy.ts",
    cli: "scripts/newsWindowStudy.ts --offline",
    sha: "7718c0e",
    family: "momentum",
    gate: "hour_veto",
    value: null,
    verdict: "rejected",
    reasons: [
      "no veto-width change justified — 3 cards in ±30 min of the biggest 8:30 releases across 657 sessions (0.1% of cards); the veto is nearly free and compliance-mandated",
    ],
    note: "measured stand-aside (gap A6) closed with 'no change'",
    applied: false,
  },
];
