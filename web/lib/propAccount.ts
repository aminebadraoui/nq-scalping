/* ------------------------------------------------------------------ *
 * Prop-account simulator — grounds every backtest in the MyFundedFutures
 * Rapid EOD 50k rules (https://help.myfundedfutures.com/en/articles/
 * 16158363-rapid-eod-50k-a-comprehensive-look).
 *
 *   · Max Loss Limit $2,000, END-OF-DAY trailing: the floor only moves at
 *     session closes, never intraday, never down.
 *   · Floor locks at $100 once it reaches there ("always keep at least $100").
 *   · Eval: profit target $3,000, 4 minimum trading days, 30% consistency
 *     (best day ≤ 30% of total profit).
 *   · Funded: first payout at the $2,100 buffer, then one per +$500.
 *   · No daily loss limit on this plan.
 *
 * Pure + client-safe. Both replay harnesses (momentumStudy.ts, db/backtest.ts)
 * feed it every run, so dollar P&L, sizing and account survival are always
 * printed alongside the point stats.
 * ------------------------------------------------------------------ */

import { RAPID_EOD_50K, momentumSize, PROP_RISK_PER_TRADE, type PropRules } from "./propRules";

export type DollarizedTrade = {
  date: string;
  pnlPts: number; // net points, costs included
  riskPts: number;
  contracts: number;
  pnl: number; // dollars
};

/** size every trade under the plan rules (fixed budget, 30-micro cap) and
 *  convert its point P&L to dollars at $2/pt MNQ. */
export function dollarize(
  trades: { date: string; pnlPts: number; riskPts: number }[],
  budget = PROP_RISK_PER_TRADE,
  rules: Pick<PropRules, "maxMicro" | "pointValue"> = RAPID_EOD_50K,
): DollarizedTrade[] {
  return trades.map((t) => {
    const size = momentumSize(t.riskPts, budget, rules);
    const pnl = Math.round(t.pnlPts * rules.pointValue * size.contracts * 100) / 100;
    return { ...t, contracts: size.contracts, pnl };
  });
}

export type AccountDay = {
  date: string;
  pnl: number;
  trades: number;
  equity: number;
  floor: number;
  locked: boolean;
};

export type AccountSimResult = {
  stage: "eval" | "funded";
  rules: string;
  startEquity: number;
  finalEquity: number;
  floor: number;
  locked: boolean;
  breachDay: string | null;
  breachEquity: number | null;
  /** eval only: first day the profit target was reached (with all gates) */
  passDay: string | null;
  passEquity: number | null;
  tradingDays: number;
  bestDay: number;
  totalProfit: number;
  consistencyOk: boolean;
  minDaysOk: boolean;
  /** funded only: payout math against the $2,100 buffer + $500 steps */
  payouts: number;
  nTrades: number;
  days: AccountDay[];
};

/**
 * Replay daily P&L through the account rules. Days are processed in calendar
 * order; the EOD floor trails only at closes and never moves down; a close
 * below the floor is a breach. `startEquity` is 0 (the plan's sim-funded
 * initial balance); the eval stage uses the same EOD MLL semantics.
 */
export function simulateAccount(
  trades: { date: string; pnl: number }[],
  stage: "eval" | "funded",
  startEquity = 0,
  rules: PropRules = RAPID_EOD_50K,
): AccountSimResult {
  // group by day, in calendar order
  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const d = byDay.get(t.date) ?? { pnl: 0, trades: 0 };
    d.pnl += t.pnl;
    d.trades++;
    byDay.set(t.date, d);
  }
  const dates = [...byDay.keys()].sort();

  let equity = startEquity;
  let floor = startEquity - rules.maxLoss;
  let locked = false;
  let breachDay: string | null = null;
  let breachEquity: number | null = null;
  let passDay: string | null = null;
  let passEquity: number | null = null;
  let tradingDays = 0;
  let bestDay = 0;
  const days: AccountDay[] = [];

  for (const date of dates) {
    const d = byDay.get(date)!;
    tradingDays += d.trades > 0 ? 1 : 0;
    equity += d.pnl;
    bestDay = Math.max(bestDay, d.pnl);

    // breach is judged at the close against the trailing floor
    if (!breachDay && equity < floor) {
      breachDay = date;
      breachEquity = equity;
    }
    // eval pass: target reached, minimum days met, AND the 30% consistency
    // gate holds AT THIS MOMENT (best day so far ≤ 30% of profit so far) —
    // MFF evaluates the gate on the day the target is reached, not at the end
    const consistencyAtPass = bestDay <= rules.consistency * (equity - startEquity);
    if (stage === "eval" && !passDay && !breachDay && equity >= rules.profitTarget && tradingDays >= rules.minDays && consistencyAtPass) {
      passDay = date;
      passEquity = equity;
    }
    days.push({ date, pnl: d.pnl, trades: d.trades, equity, floor, locked });

    // the floor trails UP at the close only, and locks at $100
    floor = Math.max(floor, equity - rules.maxLoss);
    if (!locked && floor >= 100) {
      floor = 100;
      locked = true;
    }
  }

  const totalProfit = equity - startEquity;
  const consistencyOk = totalProfit > 0 && bestDay <= rules.consistency * totalProfit;
  const minDaysOk = tradingDays >= rules.minDays;
  let payouts = 0;
  if (stage === "funded" && !breachDay && equity >= rules.buffer) {
    payouts = 1 + Math.floor((equity - rules.buffer) / rules.payoutStep);
  }

  return {
    stage,
    rules: rules.name,
    startEquity,
    finalEquity: equity,
    floor,
    locked,
    breachDay,
    breachEquity,
    passDay: breachDay ? null : passDay,
    passEquity: breachDay ? null : passEquity,
    tradingDays,
    bestDay,
    totalProfit,
    consistencyOk,
    minDaysOk,
    payouts,
    nTrades: trades.length,
    days,
  };
}

/** one-line account summary for harness output */
export function accountLine(s: AccountSimResult): string {
  if (s.breachDay) return `breach ${s.breachDay} (equity $${(s.breachEquity ?? 0).toFixed(0)})`;
  if (s.stage === "eval") {
    return s.passDay
      ? `PASS ${s.passDay} · $${s.finalEquity.toFixed(0)} · consist ${s.consistencyOk ? "✓" : "✗"} · days ${s.tradingDays}/${s.minDaysOk ? "✓" : "✗"}`
      : `no-pass · $${s.finalEquity.toFixed(0)} · consist ${s.consistencyOk ? "✓" : "✗"} · days ${s.tradingDays}`;
  }
  return `equity $${s.finalEquity.toFixed(0)} · payouts ${s.payouts} · floor $${s.floor.toFixed(0)}${s.locked ? " (locked)" : ""}`;
}
