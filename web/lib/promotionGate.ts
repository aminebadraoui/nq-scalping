/* ------------------------------------------------------------------ *
 * Promotion gate — the backtest→production promotion contract.
 *
 * The one place that decides whether an archive study's result may
 * auto-apply to production through the strategy_overrides actuator
 * (lib/strategyOverrides.ts → decideSignal(), live within ~5 min,
 * no deploy). Everything here is pure and unit-tested; the DB writes
 * live in scripts/promoteFromBacktest.ts and the nightly apply arm
 * in scripts/strategyInsights.ts (SELF_IMPROVE=1).
 *
 * Design (owner-approved 2026-10-16, "backtest to prod directly"):
 *   · Auto-promotion is allowed ONLY for the SUPPRESSIVE override gates
 *     (enable / hour_veto / trend_filter / min_break_frac /
 *     min_break_range / max_risk / first_only / side_veto /
 *     min_count_frac). A promoted gate can
 *     only remove or shrink trades, is reversible in minutes (DB row),
 *     and fails OPEN on cells it did not measure.
 *   · Detector PROD configs, Coolify env vars, and risk caps stay on
 *     the manual EXEC_CHANGE_POLICY path (backtest → tag → tests →
 *     explicit approval). This module does not weaken that rule.
 *   · Auto-revert: the nightly edge monitor deactivates auto-applied
 *     rows for a family on breach (scripts/strategyInsights.ts).
 *
 * The contract (every rule must pass; each failure is listed):
 *   1. The study script is a NAMED study allowed for the target gate.
 *   2. The T0 Stack row is declared (one layer varied against the
 *      frozen production stack — RESEARCH-LOOP rule 1).
 *   3. Sample floor: ≥ 100 total trades in the candidate cohort and
 *      ≥ 80 in the test cohort.
 *   4. Test evidence: test WR Wilson lower bound > 50%, test PF ≥ 1.1,
 *      test expR > 0 — and the gate must actually remove below-average
 *      trades (vetoed cohort test WR < baseline test WR) while not
 *      hurting the kept cohort (kept test exp ≥ 0.9 × baseline).
 *   5. Viability: prop sim (T4) PASS on train AND test, eval + funded,
 *      when viability data is supplied.
 *   6. Grid discipline: a multi-variant sweep promotes only with
 *      DSR ≥ 0.95 (deflated Sharpe, validate_sweep.py semantics) and
 *      PBO ≤ 0.20 (CSCV selection stable) — the validation-pipeline
 *      strong/stable bands.
 *   7. Veto budget: the gate may veto ≤ 30% of the family's cards —
 *      beyond that it changes the consistency math the prop sims
 *      assume (signal-frequency-sweep discipline).
 *   8. Multiple testing: the promotion ledger is the insights table
 *      (source='backtest'); every applied promotion raises the bar for
 *      the next one. v1 uses the practical bar (2pp test effect is the
 *      minimum to clear rule 4's 50%-CI floor); the SPA/MCS upgrade is
 *      tracked in docs/data/STATISTICAL_DIMENSIONS_GAP_2026-10.md B3.
 * ------------------------------------------------------------------ */

/* ---------------- gate vocabulary (mirrors scripts/strategyInsights.ts) ---------------- */

export type OverrideGate =
  | "enable"
  | "hour_veto"
  | "trend_filter"
  | "min_break_frac"
  | "min_break_range"
  | "max_risk"
  | "first_only"
  | "side_veto"
  | "min_count_frac";

/* ---------------- study-report shape (machine-readable standard) ---------------- */

export type CohortStats = {
  n: number;
  wr: number; // percent
  wrCi: [number, number]; // Wilson 95, percent
  pf: number;
  expPts: number; // net pts per trade
  expR: number; // mean pnl / risk
  sessions: number;
};

/** a cohort with its train/test split cohorts attached */
export type SplitCohort = CohortStats & { train?: CohortStats; test?: CohortStats };

export type StudyReport = {
  generated: string; // ISO timestamp
  script: string; // e.g. "scripts/momentumStudy.ts"
  cli: string; // exact flags used
  sha: string; // git sha at run time
  splitDate: string;
  stack: string; // the T0 Stack row, verbatim
  family: string; // target family, or "all"
  gate: OverrideGate; // the proposed override gate
  value: unknown; // the proposed override value
  note: string; // human note stored on the override row
  baseline: SplitCohort;
  candidate: SplitCohort;
  /** the gate removes this share of the baseline cohort (percent) */
  vetoedSharePct?: number;
  /** the vetoed trades' cohorts (the trades the gate removes) */
  vetoed?: SplitCohort;
  viability?: {
    evalPass: boolean;
    fundedPass: boolean;
    evalTestPass: boolean;
    fundedTestPass: boolean;
  };
  grid?: {
    variants: number;
    dsr?: number;
    pbo?: number;
  };
};

export type PromotionVerdict = {
  pass: boolean;
  reasons: string[]; // human-readable; empty = pass
};

/* ---------------- named-study allowlist per gate ---------------- */

/** gate → the study scripts whose report may propose it. Empty string
 *  entry = any named study may propose it. Kept narrow on purpose. */
export const PROMOTABLE_STUDIES: Record<OverrideGate, string[]> = {
  enable: ["scripts/momentumStudy.ts"],
  hour_veto: ["scripts/momentumStudy.ts", "scripts/hourExpectancyStudy.ts"],
  trend_filter: ["scripts/momentumStudy.ts"],
  min_break_frac: ["scripts/momentumStudy.ts"],
  min_break_range: ["scripts/momentumStudy.ts"],
  max_risk: ["scripts/momentumStudy.ts", "scripts/sizingOptimizer.ts"],
  first_only: ["scripts/momentumStudy.ts"],
  side_veto: ["scripts/sideVetoStudy.ts", "scripts/sideFilterStudy.ts"],
  min_count_frac: ["scripts/countFracGateStudy.ts"],
};

export const UNDECLARED_STACK_MARKER = "varying layer NOT declared";

const SUPPRESSIVE_GATES: OverrideGate[] = [
  "enable",
  "hour_veto",
  "trend_filter",
  "min_break_frac",
  "min_break_range",
  "max_risk",
  "first_only",
  "side_veto",
  "min_count_frac",
];

/* ---------------- the contract ---------------- */

const MIN_CANDIDATE_N = 100;
const MIN_TEST_N = 80;
const MIN_TEST_PF = 1.1;
const MAX_VETO_SHARE_PCT = 30;
/** Deflated Sharpe (validate_sweep.py semantics: 0..1+, HIGHER = better;
 *  ≥0.95 strong, 0.80–0.95 moderate, <0.80 weak) — a promotion needs the
 *  strong band. */
const MIN_DSR = 0.95;
/** CSCV probability of backtest overfitting — the pipeline calls
 *  PBO ≤ 0.20 "selection stable"; auto-promotion demands it. */
const MAX_PBO = 0.2;

export function checkPromotion(r: StudyReport): PromotionVerdict {
  const reasons: string[] = [];
  const fail = (msg: string) => reasons.push(msg);

  // 1. suppressive gate only
  if (!SUPPRESSIVE_GATES.includes(r.gate)) {
    fail(`gate "${r.gate}" is not auto-promotable — detector/env/risk knobs stay on the manual EXEC_CHANGE_POLICY path`);
  }

  // 2. named study allowlist
  const allowed = PROMOTABLE_STUDIES[r.gate] ?? [];
  if (allowed.length > 0 && !allowed.includes(r.script)) {
    fail(`study ${r.script} is not in the allowlist for gate "${r.gate}" (${allowed.join(", ")})`);
  }

  // 3. declared stack (one varying layer)
  if (!r.stack || r.stack.includes(UNDECLARED_STACK_MARKER)) {
    fail("T0 Stack row missing/undeclared — one layer must be varied against the frozen production stack");
  }

  // 4. sample floors
  if (r.candidate.n < MIN_CANDIDATE_N) {
    fail(`candidate cohort n=${r.candidate.n} < ${MIN_CANDIDATE_N}`);
  }
  const cTest = r.candidate.test;
  if (!cTest) {
    fail("no test cohort supplied");
  } else {
    if (cTest.n < MIN_TEST_N) fail(`test cohort n=${cTest.n} < ${MIN_TEST_N}`);
    // test evidence: WR lower CI above 50, PF ≥ bar, expR > 0
    if (!(cTest.wrCi[0] > 50)) {
      fail(`test WR lower CI ${cTest.wrCi[0].toFixed(1)}% does not clear 50%`);
    }
    if (!(cTest.pf >= MIN_TEST_PF)) {
      fail(`test PF ${cTest.pf.toFixed(2)} < ${MIN_TEST_PF}`);
    }
    if (!(cTest.expR > 0)) {
      fail(`test expR ${cTest.expR.toFixed(3)} ≤ 0`);
    }
    // the veto must remove below-average trades (needs a testable vetoed cohort)
    if (r.vetoed) {
      if (!r.vetoed.test || r.vetoed.test.n < 30) {
        fail(`vetoed test cohort n=${r.vetoed.test?.n ?? 0} < 30 — too thin to judge that the gate removes below-average trades`);
      } else if (r.baseline.test) {
        if (!(r.vetoed.test.wr < r.baseline.test.wr)) {
          fail(`vetoed cohort test WR ${r.vetoed.test.wr.toFixed(1)}% ≥ baseline test WR ${r.baseline.test.wr.toFixed(1)}% — the gate does not remove below-average trades`);
        }
        // the ticketVeto standard: the removed trades must not be able to
        // pay their own costs — otherwise the veto is cosmetic (it removes
        // profit, not risk). expPts ≤ 0.25 (half the 0.5 pt round-trip)
        // or a WR lower CI that cannot clear 50%.
        if (r.vetoed.test.expPts > 0.25 && r.vetoed.test.wrCi[0] >= 50) {
          fail(`vetoed cohort test exp ${r.vetoed.test.expPts.toFixed(2)} pts > 0.25 with WR CI lower ${r.vetoed.test.wrCi[0].toFixed(1)}% ≥ 50 — the removed trades still pay their own costs; the gate is cosmetic`);
        }
      }
    }
    // the kept cohort must not be hurt (≥ 90% of baseline expectancy)
    if (r.baseline.test && r.baseline.test.expPts > 0 && cTest.expPts < 0.9 * r.baseline.test.expPts) {
      fail(`kept test exp ${cTest.expPts.toFixed(2)} < 0.9 × baseline ${(0.9 * r.baseline.test.expPts).toFixed(2)}`);
    }
  }

  // 5. viability
  if (r.viability) {
    const v = r.viability;
    if (!v.evalPass || !v.fundedPass) fail("prop sim must PASS on train (eval + funded)");
    if (!v.evalTestPass || !v.fundedTestPass) fail("prop sim must PASS on test (eval + funded)");
  }

  // 6. grid discipline
  if (r.grid && r.grid.variants > 1) {
    if (r.grid.dsr === undefined || r.grid.pbo === undefined) {
      fail("multi-variant sweep needs DSR + PBO from the validation pipeline (gcdata/validate_sweep.py)");
    } else {
      if (r.grid.dsr < MIN_DSR) fail(`DSR ${r.grid.dsr.toFixed(3)} < ${MIN_DSR} (deflated Sharpe weak — validate_sweep.py band)`);
      if (r.grid.pbo > MAX_PBO) fail(`PBO ${r.grid.pbo.toFixed(3)} > ${MAX_PBO} (selection not stable)`);
    }
  }

  // 7. veto budget
  if (r.vetoedSharePct !== undefined && r.vetoedSharePct > MAX_VETO_SHARE_PCT) {
    fail(`gate vetoes ${r.vetoedSharePct.toFixed(1)}% of cards > ${MAX_VETO_SHARE_PCT}% budget`);
  }

  return { pass: reasons.length === 0, reasons };
}

/* ---------------- report builder (studies emit this JSON) ---------------- */

/** Turn a coreStats row into the contract's CohortStats shape. */
export function cohortOf(s: {
  n: number;
  wr: number;
  wrCi: [number, number];
  pf: number;
  expPts: number;
  expR: number;
  sessions: number;
}): CohortStats {
  return { n: s.n, wr: s.wr, wrCi: s.wrCi, pf: s.pf, expPts: s.expPts, expR: s.expR, sessions: s.sessions };
}

export function buildReport(partial: Omit<StudyReport, "generated">): StudyReport {
  return { generated: new Date().toISOString(), ...partial };
}
