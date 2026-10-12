/* ------------------------------------------------------------------ *
 * Live archive — the LIVE half of every study card and the backtest
 * page's daily-updated companion panel.
 *
 * Source of truth: the daybook's consolidated day summaries — the
 * `dayend` records that scripts/daybookConsolidate.ts writes every
 * trading night (17:45 ET Mon–Fri, from CrossTrade fills) and that the
 * nightly pipeline archives to R2.
 *
 * This module is PURE (aggregateLiveArchive — unit-tested, Node-safe).
 * The cached I/O wrapper lives in lib/liveArchiveServer.ts.
 * ------------------------------------------------------------------ */

import type { DaybookDaySummary, DaybookTradeSummary } from "./daybook";
import { familyOf } from "./tradeStats";
import { FAMILY_LABEL } from "./familyNames";
import { REPLAY_EXPR_BASELINES } from "./edgeMonitor";

export type LiveEdgeStatus = "ok" | "watch" | "breach" | "insufficient";

/** one trading day's realized result for one family */
export type LiveFamilyDay = {
  day: string;
  n: number;
  wins: number;
  losses: number;
  flats: number;
  grossUsd: number;
  netUsd: number;
};

/** one family's whole live record, accumulated over every consolidated
 *  session. `byDay` is ascending and only contains days it traded. */
export type LiveFamily = {
  family: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  flats: number;
  /** wins ÷ (wins + losses); null when no decided trades */
  wr: number | null;
  grossUsd: number;
  netUsd: number;
  commissions: number;
  /** gross win ÷ |gross loss|; null when no gross losses */
  pf: number | null;
  /** realized gross R per trade (grossUsd ÷ contracts × riskPts × $2) */
  meanExpR: number | null;
  /** the replay baseline the edge monitor compares against */
  baselineExpR: number;
  status: LiveEdgeStatus;
  firstDay: string | null;
  lastDay: string | null;
  daysTraded: number;
  byDay: LiveFamilyDay[];
};

export type LiveArchive = {
  /** newest day carrying a consolidated summary (the freshness stamp) */
  lastDay: string | null;
  /** daybook days that carried at least one dayend summary */
  sessions: number;
  /** every known family, zero-filled when it never traded */
  families: LiveFamily[];
};

/** canonical display order; unknowns found in the data are appended */
export const CANONICAL_FAMILIES = [
  "momentum_flush",
  "momentum_expansion",
  "rth",
  "open_drive",
  "open_pullback",
  "open_sniper",
  "sweep_reclaim",
  "reversal",
  "other",
] as const;

/** the trade's family: the consolidation's label wins, a verdict that
 *  maps to a real family is the fallback, anything else is "other" */
export function liveFamilyOf(t: Pick<DaybookTradeSummary, "family" | "verdict">): string {
  if (t.family && t.family !== "other") return t.family;
  return familyOf(t.verdict || "");
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** realized expR for one trade; null when the risk can't be derived
 *  (a missing price — 0 — or a missing stop or contracts) */
export function tradeLiveExpR(t: Pick<DaybookTradeSummary, "entry" | "stop" | "contracts" | "grossUsd">): number | null {
  const entry = Number(t.entry);
  const stop = Number(t.stop);
  const contracts = Number(t.contracts);
  if (![entry, stop, contracts].every(Number.isFinite) || !(entry > 0) || !(stop > 0) || !(contracts > 0)) return null;
  const riskPts = Math.abs(entry - stop);
  if (!(riskPts > 0)) return null;
  return Number(t.grossUsd) / (contracts * riskPts * 2);
}

/** the edge-monitor status over the family's WHOLE live record (the
 *  same thresholds as lib/edgeMonitor.ts — rolling window there, full
 *  history here): insufficient below 8 trades, breach when realized
 *  expR ≤ 0, watch below half the replay baseline, otherwise ok. */
export function liveEdgeStatus(n: number, meanExpR: number | null, baseline: number): LiveEdgeStatus {
  if (n < 8 || meanExpR === null) return "insufficient";
  if (meanExpR <= 0) return "breach";
  if (meanExpR < baseline * 0.5) return "watch";
  return "ok";
}

type SourceDay = { day: string; summary: DaybookDaySummary };

/** Pure aggregation: daybook dayend summaries → the per-family archive.
 *  Defensive at every step — old or partial summaries must never break
 *  the page (missing fields read as empty/zero). */
export function aggregateLiveArchive(
  days: SourceDay[],
  baselines: Record<string, number> = REPLAY_EXPR_BASELINES,
): LiveArchive {
  const known: string[] = [...CANONICAL_FAMILIES];
  const seen = new Set<string>();

  type Bucket = {
    family: string;
    n: number;
    wins: number;
    losses: number;
    flats: number;
    grossUsd: number;
    netUsd: number;
    commissions: number;
    grossWins: number;
    grossLosses: number;
    exps: number[];
    firstDay: string | null;
    lastDay: string | null;
    byDay: Map<string, LiveFamilyDay>;
  };

  const buckets = new Map<string, Bucket>();
  const ensure = (family: string): Bucket => {
    let b = buckets.get(family);
    if (!b) {
      b = { family, n: 0, wins: 0, losses: 0, flats: 0, grossUsd: 0, netUsd: 0, commissions: 0, grossWins: 0, grossLosses: 0, exps: [], firstDay: null, lastDay: null, byDay: new Map() };
      buckets.set(family, b);
    }
    if (!seen.has(family)) {
      seen.add(family);
      if (!known.includes(family)) known.push(family);
    }
    return b;
  };

  let lastDay: string | null = null;
  let sessions = 0;
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const { day, summary } of sorted) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    sessions++;
    if (lastDay === null || day > lastDay) lastDay = day;
    for (const t of summary.trades ?? []) {
      const family = liveFamilyOf(t);
      const b = ensure(family);
      const grossUsd = Number(t.grossUsd) || 0;
      const netUsd = Number(t.netUsd) || 0;
      const commissions = Number(t.commissions) || 0;
      b.n++;
      b.grossUsd += grossUsd;
      b.netUsd += netUsd;
      b.commissions += commissions;
      if (b.firstDay === null || day < b.firstDay) b.firstDay = day;
      if (b.lastDay === null || day > b.lastDay) b.lastDay = day;
      if (t.result === "win") {
        b.wins++;
        b.grossWins += grossUsd;
      } else if (t.result === "loss") {
        b.losses++;
        b.grossLosses += grossUsd;
      } else {
        b.flats++;
      }
      const expR = tradeLiveExpR(t);
      if (expR !== null && Number.isFinite(expR)) b.exps.push(expR);
      const d = b.byDay.get(day) ?? { day, n: 0, wins: 0, losses: 0, flats: 0, grossUsd: 0, netUsd: 0 };
      d.n++;
      d.grossUsd += grossUsd;
      d.netUsd += netUsd;
      if (t.result === "win") d.wins++;
      else if (t.result === "loss") d.losses++;
      else d.flats++;
      b.byDay.set(day, d);
    }
  }

  // zero-filled entries for every canonical family keep the whole
  // strategy catalog visible — a family that never fires is a finding
  for (const family of known) ensure(family);

  const families: LiveFamily[] = known.map((family) => {
    const b = buckets.get(family)!;
    const decided = b.wins + b.losses;
    const meanExpR = b.exps.length ? b.exps.reduce((s, x) => s + x, 0) / b.exps.length : null;
    const baseline = baselines[family] ?? baselines.other ?? 0.2;
    return {
      family,
      label: FAMILY_LABEL[family] ?? family,
      n: b.n,
      wins: b.wins,
      losses: b.losses,
      flats: b.flats,
      wr: decided > 0 ? b.wins / decided : null,
      grossUsd: r2(b.grossUsd),
      netUsd: r2(b.netUsd),
      commissions: r2(b.commissions),
      pf: b.grossLosses < 0 ? r2(b.grossWins / -b.grossLosses) : null,
      meanExpR: meanExpR === null ? null : r2(meanExpR),
      baselineExpR: baseline,
      status: liveEdgeStatus(b.n, meanExpR, baseline),
      firstDay: b.firstDay,
      lastDay: b.lastDay,
      daysTraded: b.byDay.size,
      byDay: [...b.byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({ ...d, grossUsd: r2(d.grossUsd), netUsd: r2(d.netUsd) })),
    };
  });

  return { lastDay, sessions, families };
}
