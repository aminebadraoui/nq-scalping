/* ------------------------------------------------------------------ *
 * Kelly sizing — the arithmetic-of-a-coin-flip layer (Medallion
 * documentary, docs/research/medallion-documentary-2026-10-07.md).
 *
 *   f* = p − (1−p)/b      (p = win rate, b = avg win R ÷ avg loss R)
 *   Reference point: 50.75% even-money → f* = 1.5% of capital.
 *
 * Sizing mode (relative to the validated flat day plan): the plan's
 * flat $100 is the anchor. risk$ = flatRisk × kellyMult × f / fRef,
 * where fRef is the PRIOR's own Kelly fraction — so when the live
 * evidence is thin the estimate equals the prior and the risk equals
 * the flat budget exactly. Kelly doctrine: f ≤ 0 → stand aside
 * (contracts 0), whatever the floor.
 *
 * Two consumers, one book:
 *   · backtests — dollarizeKelly(): walks a dated trade sequence forward,
 *     sizes each trade from ONLY prior trades (shrunken, per-family
 *     state), and returns the same DollarizedTrade[] shape that
 *     simulateAccount() consumes, so the MFF sim is untouched.
 *   · live cards — kellyLiveChip() (lib/kellyLive.ts) folds the recent
 *     signals-table outcomes into the same estimator. JOURNAL-ONLY:
 *     the chip prints on the card and lands in features jsonb; sizing
 *     follows it only when KELLY_LIVE_USE=1 (default OFF).
 *
 * Pure + client-safe. Unit-tested in tests/kelly.test.ts.
 * ------------------------------------------------------------------ */

import { momentumSize, RAPID_EOD_50K, type PropRules } from "./propRules";
import type { DollarizedTrade } from "./propAccount";

/** decided-trade evidence for one family (wins + losses; zero-pnl trades
 *  carry no R information and never touch the state) */
export type KellyFamilyState = {
  wins: number;
  losses: number;
  /** sum of realized R on wins (pnlPts / riskPts) */
  sumWinR: number;
  /** sum of realized R on losses (positive numbers) */
  sumLossR: number;
};

/** the shrink anchor — virtual trades seeded into every estimate. Live
 *  cards use the playbook stats; backtests derive priors from the TRAIN
 *  window only (no lookahead). */
export type KellyPrior = {
  wins: number;
  losses: number;
  winR: number;
  lossR: number;
};

export type KellyConfig = {
  /** fraction of the Kelly ratio to bet (1 = full relative Kelly) */
  kellyMult: number;
  /** the flat day-plan anchor the ratio scales ($100) */
  flatRisk: number;
  /** hard $ risk ceiling per trade */
  maxRisk: number;
  /** $ risk floor per trade (stand-aside overrides it) */
  minRisk: number;
  /** cap on f* itself — a shrunk estimate is never trusted past 50% */
  maxFrac: number;
  prior: KellyPrior;
};

export const KELLY_DEFAULTS: KellyConfig = {
  kellyMult: 1,
  flatRisk: 100,
  maxRisk: 150,
  minRisk: 25,
  maxFrac: 0.5,
  prior: { wins: 8, losses: 3, winR: 1, lossR: 1 },
};

/** family priors from the playbook (live journal anchor only) */
export const KELLY_PRIORS: Record<string, KellyPrior> = {
  // momentum flush 77.5% @ 1R · expansion 78.4% @ 1R (playbook)
  momentum_flush: { wins: 31, losses: 9, winR: 1, lossR: 1 },
  momentum_expansion: { wins: 31, losses: 9, winR: 1, lossR: 1 },
  // RTH live limit bracket 37.7% @ 2.5R, 0.5× stop (rthLimitValidation)
  rth: { wins: 15, losses: 25, winR: 1.25, lossR: 0.5 },
  default: { wins: 8, losses: 3, winR: 1, lossR: 1 },
};

export const EMPTY_K_STATE: KellyFamilyState = { wins: 0, losses: 0, sumWinR: 0, sumLossR: 0 };

/** raw Kelly fraction for a win rate and odds ratio (not shrunk, not capped) */
export function kellyFraction(p: number, b: number): number {
  if (!(b > 0) || !(p > 0)) return 0;
  return p - (1 - p) / b;
}

export type KellyEstimate = {
  /** decided trades in the state (wins + losses) */
  n: number;
  /** shrunk win rate */
  p: number;
  /** shrunk avg win R ÷ avg loss R */
  b: number;
  /** shrunk Kelly fraction, clamped to [0, maxFrac] */
  f: number;
  /** the prior's own Kelly fraction (the flat anchor) */
  fRef: number;
  /** f / fRef — 1 = trade flat */
  ratio: number;
  /** $ risk for the NEXT trade */
  risk: number;
  /** f ≤ 0 → stand aside (risk 0, contracts 0) */
  skip: boolean;
};

/**
 * Shrunk Kelly estimate from a family's decided-trade evidence. The
 * prior pulls p and the R means toward the playbook anchor, so a thin
 * live sample can never flip sizing on one lucky streak.
 */
export function kellyEstimate(st: KellyFamilyState, cfg: KellyConfig = KELLY_DEFAULTS): KellyEstimate {
  const { prior, kellyMult, flatRisk, maxRisk, minRisk, maxFrac } = cfg;
  const n = st.wins + st.losses;
  const denom = n + prior.wins + prior.losses;
  if (!(denom > 0)) {
    return { n, p: 0, b: 1, f: 0, fRef: 0, ratio: 0, risk: 0, skip: true };
  }
  const p = (st.wins + prior.wins) / denom;
  const winR = (st.sumWinR + prior.wins * prior.winR) / (st.wins + prior.wins);
  const lossR = (st.sumLossR + prior.losses * prior.lossR) / (st.losses + prior.losses);
  const b = Math.max(0.1, winR / Math.max(0.01, lossR));
  const pRef = prior.wins / (prior.wins + prior.losses);
  const bRef = Math.max(0.1, prior.winR / Math.max(0.01, prior.lossR));
  const fRef = Math.max(0, kellyFraction(pRef, bRef));
  const f = Math.min(maxFrac, Math.max(0, kellyFraction(p, b)));
  const skip = f <= 0;
  const ratio = fRef > 0 ? f / fRef : 0;
  const risk = skip ? 0 : Math.min(maxRisk, Math.max(minRisk, flatRisk * kellyMult * ratio));
  return { n, p, b, f, fRef, ratio, risk: Math.round(risk * 100) / 100, skip };
}

/** fold one decided trade's realized R into the state. Called AFTER the
 *  trade is sized — the estimate for trade t uses only trades before t. */
export function applyKellyOutcome(st: KellyFamilyState, pnlPts: number, riskPts: number): void {
  if (!(riskPts > 0)) return;
  if (pnlPts > 0) {
    st.wins++;
    st.sumWinR += pnlPts / riskPts;
  } else if (pnlPts < 0) {
    st.losses++;
    st.sumLossR += -pnlPts / riskPts;
  }
  // zero-pnl trades (flat/time) carry no R information — ignored
}

export type KellyTrade = { date: string; pnlPts: number; riskPts: number; family?: string };

/** config per family — the pool replay sizes each family from its OWN
 *  train-window prior (the live book does the same via KELLY_PRIORS) */
export type KellyConfigFn = (family: string) => KellyConfig;

/**
 * The backtest Kelly sizer. Walks the dated sequence forward and sizes
 * every trade from the shrunken per-family estimate built from PRIOR
 * trades only. `cfg` may be one shared config or a resolver that picks
 * the config (prior included) per family. Stand-aside trades (f ≤ 0)
 * come back with contracts 0 and pnl 0 — the same DollarizedTrade shape
 * simulateAccount() already consumes, so the MFF sim is unchanged.
 */
export function dollarizeKelly(
  trades: KellyTrade[],
  cfg: Partial<KellyConfig> | KellyConfigFn = {},
  rules: Pick<PropRules, "maxMicro" | "pointValue"> = RAPID_EOD_50K,
): DollarizedTrade[] {
  const shared: KellyConfig = { ...KELLY_DEFAULTS, ...(typeof cfg === "function" ? {} : cfg) };
  const configFor = (fam: string): KellyConfig => (typeof cfg === "function" ? cfg(fam) : shared);
  const states = new Map<string, KellyFamilyState>();
  return trades.map((t) => {
    const fam = t.family ?? "default";
    const st = states.get(fam) ?? { ...EMPTY_K_STATE };
    const est = kellyEstimate(st, configFor(fam));
    const size = est.skip ? { contracts: 0 } : momentumSize(t.riskPts, est.risk, rules);
    const pnl = size.contracts === 0 ? 0 : Math.round(t.pnlPts * rules.pointValue * size.contracts * 100) / 100;
    applyKellyOutcome(st, t.pnlPts, t.riskPts);
    states.set(fam, st);
    return { date: t.date, pnlPts: t.pnlPts, riskPts: t.riskPts, contracts: size.contracts, pnl };
  });
}

/** KELLY_* env overrides (live cards). Every knob is OFF by default —
 *  unset env = the flat day plan, exactly as today. Only DEFINED keys are
 *  returned, so spreading this over the defaults never clobbers them
 *  with undefined. */
export function kellyEnvOverrides(): Partial<KellyConfig> {
  const num = (k: string): number | undefined => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const min = Number(process.env.KELLY_MIN_RISK);
  const over: Partial<KellyConfig> = {};
  const kellyMult = num("KELLY_MULT");
  const maxRisk = num("KELLY_MAX_RISK");
  const maxFrac = num("KELLY_MAX_FRAC");
  if (kellyMult !== undefined) over.kellyMult = kellyMult;
  if (maxRisk !== undefined) over.maxRisk = maxRisk;
  if (Number.isFinite(min) && min >= 0) over.minRisk = min;
  if (maxFrac !== undefined) over.maxFrac = maxFrac;
  return over;
}
