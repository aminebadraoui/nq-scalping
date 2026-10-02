/* ------------------------------------------------------------------ *
 * Edge monitor — is the live edge still there?
 *
 * Compares each family's rolling live expectancy (mean gross R per
 * trade, computed from the reconciled trades) against its replay
 * baseline. Expectancy-per-R is the exit-style-independent metric — it
 * works whether the account runs fixed 1R exits or the ladder
 * (win RATE is not comparable across exit styles; expR is).
 *
 *   status: insufficient (n < 8) | ok | watch (live expR below half the
 *           baseline) | breach (live expR ≤ 0 — the edge is gone)
 *
 * The insight CLI persists one row per family (kind = "edge_monitor")
 * so the journal shows the family's edge health next to its stats.
 * ------------------------------------------------------------------ */

import type { EnrichedTrade } from "./tradeStats";

/** replay baselines (expR per trade, 648-session archive, Oct 2026):
 *  momentum_flush   0.44 (rr1.0 fixed-1R sweep) / 0.47 ladder
 *  momentum_expansion 0.48 (1.6×ATR + stack)
 *  rth              0.44 (82.2% @ 0.75R plan)
 *  open_drive       0.33 (93% hit @ TP15/SL35)
 *  open_pullback    0.40 (69.8% @ 1R, +5.2 pts)
 *  open_sniper      0.30 (55.8% @ 1R, +6.5 pts)
 *  sweep_reclaim    0.34 (67% @ 1R) */
export const REPLAY_EXPR_BASELINES: Record<string, number> = {
  momentum_flush: 0.44,
  momentum_expansion: 0.48,
  rth: 0.44,
  open_drive: 0.33,
  open_pullback: 0.4,
  open_sniper: 0.3,
  sweep_reclaim: 0.34,
  other: 0.2,
};

export type EdgeStatus = {
  family: string;
  n: number;
  wins: number;
  losses: number;
  meanExpR: number | null;
  baselineExpR: number;
  status: "ok" | "watch" | "breach" | "insufficient";
  detail: string;
};

/** per-trade expR: gross R realized (grossUsd ÷ (contracts × riskPts × $2)) */
export function tradeExpR(t: EnrichedTrade): number | null {
  const denom = t.contracts * t.riskPts * 2;
  return denom > 0 && Number.isFinite(t.grossUsd) ? t.grossUsd / denom : null;
}

export function edgeStatuses(
  rows: EnrichedTrade[],
  opts: { window?: number; baselines?: Record<string, number> } = {},
): EdgeStatus[] {
  const window = opts.window ?? 30;
  const baselines = opts.baselines ?? REPLAY_EXPR_BASELINES;
  const byFamily = new Map<string, EnrichedTrade[]>();
  for (const r of rows) {
    const a = byFamily.get(r.family) ?? [];
    a.push(r);
    byFamily.set(r.family, a);
  }
  const out: EdgeStatus[] = [];
  for (const [family, all] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const recent = all.slice(-window);
    const n = recent.length;
    const wins = recent.filter((r) => r.result === "win").length;
    const losses = recent.filter((r) => r.result === "loss").length;
    const baseline = baselines[family] ?? baselines.other ?? 0.2;
    if (n < 8) {
      out.push({
        family,
        n,
        wins,
        losses,
        meanExpR: null,
        baselineExpR: baseline,
        status: "insufficient",
        detail: `only ${n} live trades — collecting (need 8)`,
      });
      continue;
    }
    const expRs = recent.map(tradeExpR).filter((x): x is number => x !== null);
    const mean = expRs.length ? expRs.reduce((s, x) => s + x, 0) / expRs.length : null;
    let status: EdgeStatus["status"] = "ok";
    if (mean === null || mean <= 0) status = "breach";
    else if (mean < 0.5 * baseline) status = "watch";
    out.push({
      family,
      n,
      wins,
      losses,
      meanExpR: mean,
      baselineExpR: baseline,
      status,
      detail:
        `live expR ${mean === null ? "—" : mean.toFixed(2)} vs baseline ${baseline.toFixed(2)} ` +
        `(${wins}W/${losses}L last ${n})`,
    });
  }
  return out;
}
