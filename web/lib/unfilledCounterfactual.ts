/* ------------------------------------------------------------------ *
 * Unfilled counterfactual — the hypothetical outcome of every recorded
 * card that never got a fill (vetoed, gated, retrace-expired, or
 * unexecuted).
 *
 * The signal scorer already replays every recorded signal against the
 * session tape (lib/signalScorer.ts → signals.outcome). This module
 * aggregates the UNFILLED slice of that replay so the AI review and
 * the journal can answer: did the gates + fills filter out winners
 * (cost) or losers (protection)?
 *
 * RULES: hypothetical points are NEVER real P&L — they assume a limit
 * fill at the signal entry with no slippage or commission. Every
 * consumer must label them "would-be". Win = +|target−entry| pts,
 * loss = −|stop−entry| pts, time = 0.
 * Pure + unit-tested.
 * ------------------------------------------------------------------ */

import { familyOf } from "./tradeStats";

export type CounterfactualSignal = {
  key: string;
  verdict: string;
  side: string;
  entry: string;
  stop: string;
  target: string;
  outcome: string; // win | loss | time | open | ''
};

export type CounterfactualFamily = {
  family: string;
  n: number;
  wins: number;
  losses: number;
  times: number;
  wr: number;
  wouldBePts: number;
};

export type Counterfactual = {
  /** unfilled signals examined (not in filledKeys) */
  total: number;
  /** outcomes still open/blank — not decided yet */
  unscored: number;
  /** decided by the replay: win + loss + time */
  decided: number;
  wins: number;
  losses: number;
  times: number;
  /** wins ÷ decided (time excluded from the ratio) */
  wr: number;
  /** hypothetical pts over the decided slice (see RULES) */
  wouldBePts: number;
  byFamily: CounterfactualFamily[];
};

const pts = (s: CounterfactualSignal): number | null => {
  const entry = parseFloat(s.entry);
  const stop = parseFloat(s.stop);
  const target = parseFloat(s.target);
  if (![entry, stop, target].every(Number.isFinite)) return null;
  if (s.outcome === "win") return Math.abs(target - entry);
  if (s.outcome === "loss") return -Math.abs(stop - entry);
  return 0;
};

/** aggregate the unfilled slice of the replay over one window */
export function unfilledCounterfactual(
  signals: CounterfactualSignal[],
  filledKeys: Set<string>,
): Counterfactual {
  const unfilled = signals.filter((s) => !filledKeys.has(s.key));
  const out: Counterfactual = {
    total: unfilled.length,
    unscored: 0,
    decided: 0,
    wins: 0,
    losses: 0,
    times: 0,
    wr: 0,
    wouldBePts: 0,
    byFamily: [],
  };
  const byFam = new Map<string, CounterfactualFamily>();

  for (const s of unfilled) {
    if (s.outcome !== "win" && s.outcome !== "loss" && s.outcome !== "time") {
      out.unscored++;
      continue;
    }
    const p = pts(s);
    if (p === null) {
      out.unscored++;
      continue;
    }
    out.decided++;
    if (s.outcome === "win") out.wins++;
    else if (s.outcome === "loss") out.losses++;
    else out.times++;
    out.wouldBePts += p;

    const f = familyOf(s.verdict);
    const e = byFam.get(f) ?? { family: f, n: 0, wins: 0, losses: 0, times: 0, wr: 0, wouldBePts: 0 };
    e.n++;
    if (s.outcome === "win") e.wins++;
    else if (s.outcome === "loss") e.losses++;
    else e.times++;
    e.wouldBePts += p;
    byFam.set(f, e);
  }

  const decidedForWr = out.wins + out.losses;
  out.wr = decidedForWr > 0 ? out.wins / decidedForWr : 0;
  out.wouldBePts = Math.round(out.wouldBePts * 100) / 100;
  for (const e of byFam.values()) {
    const d = e.wins + e.losses;
    e.wr = d > 0 ? e.wins / d : 0;
    e.wouldBePts = Math.round(e.wouldBePts * 100) / 100;
  }
  out.byFamily = [...byFam.values()].sort((a, b) => b.n - a.n);
  return out;
}
