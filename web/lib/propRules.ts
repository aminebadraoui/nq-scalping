/* ------------------------------------------------------------------ *
 * Prop-firm challenge calculator — MyFundedFutures Rapid EOD 50k,
 * sized for MNQ, driven by the sweep-reclaim strategy's backtest stats.
 *
 * Pure + client-safe. The dashboard (PropPanel) uses the fast expected-value
 * estimate; gcdata/prop_sim.py runs the full Monte Carlo over the real trade
 * sequence (pass / ruin / payout timeline).
 * ------------------------------------------------------------------ */

export type PropRules = {
  name: string;
  profitTarget: number;
  maxLoss: number;
  /** eval-only consistency: best day ≤ this share of total profit */
  consistency: number;
  minDays: number;
  maxMicro: number;
  /** $ per 1.0 index point (MNQ = $2, 0.25pt tick = $0.50) */
  pointValue: number;
  /** funded-stage buffer before the first payout */
  buffer: number;
  /** profit per subsequent payout unlock */
  payoutStep: number;
  /** trader share */
  split: number;
};

export const RAPID_EOD_50K: PropRules = {
  name: "Rapid EOD 50k",
  profitTarget: 3000,
  maxLoss: 2000,
  consistency: 0.3,
  minDays: 4,
  maxMicro: 30,
  pointValue: 2,
  buffer: 2100,
  payoutStep: 500,
  split: 0.9,
};

/** sweep-reclaim strategy stats, from the 2.5-year backtest */
export const STRATEGY = {
  winRate: 0.67,
  rPts: 4.25, // median stop distance (pts)
  rPtsP25: 2.25,
  rPtsP75: 7.25,
  setupsPerDay: 2.24,
  expectancyR: 0.34, // 1R target: 0.67 - 0.33
};

export function riskPerContract(rPts = STRATEGY.rPts, pointValue = RAPID_EOD_50K.pointValue): number {
  return rPts * pointValue;
}

export function contractsForRisk(riskDollars: number, rPts = STRATEGY.rPts, pointValue = RAPID_EOD_50K.pointValue): number {
  return riskDollars / (rPts * pointValue);
}

/** Fixed dollar risk per trade. $170 ≈ 8.5% of the $2,000 Max Loss Limit —
 *  ten consecutive full losses still leaves $300 of drawdown headroom. */
export const PROP_RISK_PER_TRADE = 170;

export type MomentumSize = {
  contracts: number;
  dollarRisk: number;
  capped: boolean; // true when the 30-micro contract limit bound the size
};

/** Momentum-card sizing, grounded in the Rapid EOD 50k rules:
 *  contracts = riskBudget ÷ (riskPts × $2/MNQ), floored at 1, capped at the
 *  plan's 30-micro contract limit. Dollar risk is what those contracts
 *  actually risk — always ≤ riskBudget. */
export function momentumSize(
  riskPts: number,
  riskBudget = PROP_RISK_PER_TRADE,
  rules: Pick<PropRules, "maxMicro" | "pointValue"> = RAPID_EOD_50K,
): MomentumSize {
  const perContract = Math.max(0.01, riskPts) * rules.pointValue;
  const raw = Math.floor(riskBudget / perContract);
  const contracts = Math.min(rules.maxMicro, Math.max(1, raw));
  return {
    contracts,
    dollarRisk: Math.round(contracts * perContract * 100) / 100,
    capped: raw > rules.maxMicro,
  };
}

export type EvalEstimate = {
  contracts: number;
  riskPerTrade: number;
  dailyProfit: number;
  /** expected days to the $3,000 target (mean; ignores consistency/drawdown) */
  daysToPass: number;
  /** funded-stage expected income at the 90% split */
  weeklyIncome: number;
/** risk at the 30-micro cap, median R */
  maxContractRisk: number;
};

  /**
 * Fixed-contract sizing with a hard DOLLAR risk ceiling: contracts =
 * min(fixed, floor(cap ÷ (riskPts × pointValue))), floored at 1.
 * Used by the RTH + open families, whose structural stops vary wildly
 * (3–35 pts), so a fixed contract count alone lets dollar risk swing
 * from ~$50 to ~$600. cap <= 0 = no ceiling (raw fixed count).
 */
export function cappedContracts(
  fixed: number,
  riskPts: number,
  dollarCap: number,
  pointValue: number = 2,
): number {
  if (!(dollarCap > 0) || !(riskPts > 0)) return Math.max(1, fixed);
  return Math.max(1, Math.min(Math.max(1, fixed), Math.floor(dollarCap / (riskPts * pointValue))));
}

export function estimateEval(rules: PropRules, riskPerTrade: number): EvalEstimate {
  const dailyProfit = STRATEGY.expectancyR * STRATEGY.setupsPerDay * riskPerTrade;
  const daysToPass = Math.max(rules.minDays, rules.profitTarget / dailyProfit);
  const weeklyIncome = dailyProfit * 5 * rules.split;
  return {
    contracts: contractsForRisk(riskPerTrade),
    riskPerTrade,
    dailyProfit,
    daysToPass,
    weeklyIncome,
    maxContractRisk: rules.maxMicro * riskPerContract(),
  };
}
