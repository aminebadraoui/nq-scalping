/* ------------------------------------------------------------------ *
 * Strategy insight miner — the "what could we improve" engine.
 *
 * Pure functions over the enriched trade rows (lib/tradeStats.ts +
 * the signal-time feature vector captured by the feed): it buckets
 * trades by categorical and numeric features, measures win rate /
 * net P&L / stop-run rate per bucket, and turns meaningful deviations
 * from the family baseline into machine-readable insights:
 *
 *   · rule_proposal — a concrete gate change (hour veto, trend filter,
 *     min break fraction, max risk, first-of-day only) with evidence;
 *     flagged `autoApply` when the evidence is strong (the nightly CLI
 *     applies those when SELF_IMPROVE=1, otherwise a human approves
 *     from the dashboard)
 *   · observation   — a measurable pattern without a safe gate yet
 *   · execution     — fill-quality findings (adverse drift, stop slips)
 *
 * Deliberately conservative: minimum sample sizes per bucket, and a
 * proposal only fires when the bucket is BOTH far from the baseline
 * AND net negative (or strongly positive for concentration notes).
 * This is statistics, not narrative — the AI synthesis layer
 * (scripts/strategyInsights.ts, LLM or deterministic) turns these into
 * prose and priorities.
 * ------------------------------------------------------------------ */

import type { EnrichedTrade } from "./tradeStats";
import { canonicalFamily } from "./strategies/aliases";

export type GateName =
  | "enable"
  | "hour_veto"
  | "trend_filter"
  | "min_break_frac"
  | "min_break_range"
  | "max_risk"
  | "first_only";

export type ProposedAction = {
  family: string;
  gate: GateName;
  value: unknown;
  note: string;
};

export type Insight = {
  strategy: string; // family or "all"
  kind: "rule_proposal" | "observation" | "execution" | "narrative";
  severity: "info" | "warn" | "opportunity";
  title: string;
  finding: string;
  evidence: Record<string, unknown>;
  proposedAction: ProposedAction | null;
  autoApply: boolean;
};

export type AnalyzedTrade = EnrichedTrade & {
  features?: Record<string, unknown> | null;
};

type Bucket = {
  n: number;
  wins: number;
  losses: number;
  wr: number | null;
  netUsd: number;
  grossUsd: number;
  stopRuns: number;
  avgMfe: number | null;
  avgMae: number | null;
  avgAdverse: number | null;
};

function bucket(rows: AnalyzedTrade[]): Bucket {
  const wins = rows.filter((r) => r.result === "win");
  const losses = rows.filter((r) => r.result === "loss");
  const mfe = rows.filter((r) => r.mfePts !== null);
  const mae = rows.filter((r) => r.maePts !== null);
  const adv = rows.filter((r) => Number.isFinite(r.entryAdversePts));
  return {
    n: rows.length,
    wins: wins.length,
    losses: losses.length,
    wr: rows.length ? wins.length / rows.length : null,
    netUsd: rows.reduce((s, r) => s + r.netUsd, 0),
    grossUsd: rows.reduce((s, r) => s + r.grossUsd, 0),
    stopRuns: losses.filter((r) => r.stopRun).length,
    avgMfe: mfe.length ? mfe.reduce((s, r) => s + (r.mfePts ?? 0), 0) / mfe.length : null,
    avgMae: mae.length ? mae.reduce((s, r) => s + (r.maePts ?? 0), 0) / mae.length : null,
    avgAdverse: adv.length ? adv.reduce((s, r) => s + r.entryAdversePts, 0) / adv.length : null,
  };
}

/** bucket stats for an arbitrary key function */
export function bucketStats(rows: AnalyzedTrade[], key: (r: AnalyzedTrade) => string): Map<string, Bucket> {
  const m = new Map<string, AnalyzedTrade[]>();
  for (const r of rows) {
    const k = key(r);
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  }
  const out = new Map<string, Bucket>();
  for (const [k, v] of m) out.set(k, bucket(v));
  return out;
}

function num(r: AnalyzedTrade, key: string): number | null {
  const f = r.features ?? null;
  if (!f) return null;
  const v = (f as Record<string, unknown>)[key];
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined ? n : null;
}

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(Math.round(n))}`;

function hourLabel(bucketKey: string): string {
  switch (bucketKey) {
    case "globex_early":
      return "18–21 ET";
    case "globex_core":
      return "21–00 ET";
    case "globex_late":
      return "00–03 ET";
    case "globex_dawn":
      return "03–06 ET";
    case "premkt":
      return "06–09:30 ET";
    case "rth":
      return "09:30–16 ET";
    case "close":
      return "16–18 ET";
    default:
      return bucketKey;
  }
}

export type MineOpts = {
  /** validate rule proposals out-of-sample: the bucket must also lose on
   *  the most recent third of its trades, or the proposal is downgraded
   *  to an observation. Default in the CLI: ON. */
  walkForward?: boolean;
};

const MIN_N_VETO = 6;
const MIN_N_CONCENTRATE = 8;
const MIN_N_GATE = 8;
const WR_VETO = 0.25;
const WR_CONCENTRATE = 0.75;
const DELTA_WR_GATE = 0.2;

export function mineInsights(rows: AnalyzedTrade[], opts: MineOpts = {}): Insight[] {
  const out: Insight[] = [];
  if (rows.length < 4) return out;

  // 2026-10-19 rename bridge: rows from before the rename carry legacy
  // family slugs — canonicalize once so every bucket/filter agrees.
  rows = rows.map((r) => ({ ...r, family: canonicalFamily(r.family) }));

  /** walk-forward check: the proposal must hold on the newest third of
   *  the bucket's trades (test wr <= veto+10pp AND test net < 0), or it
   *  is downgraded to an observation. */
  const validate = (proposal: Insight, bucketRows: AnalyzedTrade[]): Insight => {
    if (!opts.walkForward || proposal.kind !== "rule_proposal") return proposal;
    const sorted = [...bucketRows].sort((a, b) => a.ts - b.ts);
    const cut = Math.floor((sorted.length * 2) / 3);
    const train = sorted.slice(0, cut);
    const test = sorted.slice(cut);
    if (test.length < 4) {
      proposal.evidence.walkForward = {
        trainN: train.length,
        testN: test.length,
        note: "insufficient out-of-sample data — proposal held, not auto-applied",
      };
      proposal.autoApply = false;
      return proposal;
    }
    const bTest = bucket(test);
    const holds = bTest.wr !== null && bTest.wr <= WR_VETO + 0.1 && bTest.netUsd < 0;
    proposal.evidence.walkForward = {
      trainN: train.length,
      testN: test.length,
      testWr: bTest.wr,
      testNetUsd: bTest.netUsd,
      holds,
    };
    if (!holds) {
      proposal.kind = "observation";
      proposal.severity = "info";
      proposal.proposedAction = null;
      proposal.autoApply = false;
      proposal.finding += ` — FAILED walk-forward (test ${pct(bTest.wr)}, ${usd(bTest.netUsd)} net).`;
    }
    return proposal;
  };

  const overall = bucket(rows);
  const byFamily = bucketStats(rows, (r) => r.family);
  const byHour = bucketStats(rows, (r) => r.hourBucket);
  const bySide = bucketStats(rows, (r) => r.side);
  const firstOfDay = bucket(rows.filter((r) => r.firstOfDay));
  const restOfDay = bucket(rows.filter((r) => !r.firstOfDay));

  // ---- 1. family × hour: lose-money buckets → hour veto; hot buckets → concentrate
  for (const [family, famRows] of groupRows(rows, (r) => r.family)) {
    const famBase = byFamily.get(family)!;
    if (famBase.n < MIN_N_VETO) continue;
    const famHours = bucketStats(famRows, (r) => r.hourBucket);
    const famHoursRows = groupRows(famRows, (r) => r.hourBucket);
    for (const [hb, b] of famHours) {
      if (hb === "unknown") continue;
      if (b.n >= MIN_N_VETO && b.wr !== null && b.wr <= WR_VETO && b.netUsd < 0) {
        const vetoHours = hoursInBucket(hb);
        out.push(
          validate(
            {
              strategy: family,
              kind: "rule_proposal",
              severity: "warn",
              title: `${family} loses in ${hourLabel(hb)}`,
              finding: `${b.n} trades in ${hourLabel(hb)}: ${pct(b.wr)} win (${b.wins}W/${b.losses}L), ${usd(b.netUsd)} net, ${b.stopRuns} stop-runs — vs family baseline ${pct(famBase.wr)}.`,
              evidence: { n: b.n, wr: b.wr, netUsd: b.netUsd, stopRuns: b.stopRuns, baselineWr: famBase.wr },
              proposedAction: {
                family,
                gate: "hour_veto",
                value: { hours: vetoHours, bucket: hb },
                note: `skip ${family} signals in ${hourLabel(hb)}`,
              },
              autoApply: b.n >= 10 && b.wr !== null && b.wr <= 0.2,
            },
            famHoursRows.get(hb) ?? [],
          ),
        );
      } else if (b.n >= MIN_N_CONCENTRATE && b.wr !== null && b.wr >= WR_CONCENTRATE) {
        out.push({
          strategy: family,
          kind: "observation",
          severity: "opportunity",
          title: `${family} is strongest in ${hourLabel(hb)}`,
          finding: `${b.n} trades in ${hourLabel(hb)}: ${pct(b.wr)} win, ${usd(b.netUsd)} net — the family's best window (baseline ${pct(famBase.wr)}).`,
          evidence: { n: b.n, wr: b.wr, netUsd: b.netUsd, baselineWr: famBase.wr },
          proposedAction: null,
          autoApply: false,
        });
      }
    }
  }

  // ---- 2. expansion trigger: if weak overall → trend filter proposal
  const exp = rows.filter((r) => r.family === "huge_bar_expansion");
  if (exp.length >= MIN_N_GATE) {
    const b = bucket(exp);
    if (b.wr !== null && b.wr <= 0.3) {
      const withTrend = exp.filter((r) => {
        const cd = num(r, "cumDelta");
        if (cd === null) return null;
        return r.side === "long" ? cd > 0 : cd < 0;
      });
      const against = exp.filter((r) => {
        const cd = num(r, "cumDelta");
        if (cd === null) return null;
        return r.side === "long" ? cd <= 0 : cd >= 0;
      });
      const bWith = bucket(withTrend.filter((x): x is AnalyzedTrade => x !== null));
      const bAgainst = bucket(against.filter((x): x is AnalyzedTrade => x !== null));
      const evidence: Record<string, unknown> = { n: b.n, wr: b.wr, netUsd: b.netUsd };
      if (bWith.n > 0) evidence.withTrendWr = bWith.wr;
      if (bAgainst.n > 0) evidence.againstTrendWr = bAgainst.wr;
      out.push(
        validate(
          {
            strategy: "huge_bar_expansion",
            kind: "rule_proposal",
            severity: "warn",
            title: "momentum expansion needs a session-trend filter",
            finding: `${b.n} expansion trades: ${pct(b.wr)} win, ${usd(b.netUsd)} net${
              bWith.n && bAgainst.n
                ? ` — with-trend ${pct(bWith.wr)} vs against-trend ${pct(bAgainst.wr)}`
                : ""
            }. The huge-bar trigger keeps firing against one-sided session runs.`,
            evidence,
            proposedAction: {
              family: "huge_bar_expansion",
              gate: "trend_filter",
              value: { required: true, on: "cumDelta" },
              note: "only take expansion entries in the session cumulative-delta direction",
            },
            autoApply: b.wr !== null && b.wr <= 0.2,
          },
          exp,
        ),
      );
    }
  }

  // ---- 3. side split per family (longs vs shorts)
  for (const [family, famRows] of groupRows(rows, (r) => r.family)) {
    if (famRows.length < MIN_N_VETO) continue;
    for (const side of ["long", "short"] as const) {
      const b = bucket(famRows.filter((r) => r.side === side));
      if (b.n >= MIN_N_VETO && b.wr !== null && b.wr <= WR_VETO && b.netUsd < 0) {
        out.push({
          strategy: family,
          kind: "observation",
          severity: "warn",
          title: `${family} ${side}s are bleeding`,
          finding: `${b.n} ${side}s: ${pct(b.wr)} win, ${usd(b.netUsd)} net, ${b.stopRuns} stop-runs (${b.losses} losses).`,
          evidence: { side, n: b.n, wr: b.wr, netUsd: b.netUsd, stopRuns: b.stopRuns },
          proposedAction: null,
          autoApply: false,
        });
      }
    }
  }

  // ---- 4. numeric feature tiers (breakFrac, breakRangeR, riskPts) — gate proposals
  for (const feat of ["breakFrac", "breakRangeR", "riskPts"] as const) {
    const withFeat = rows.filter((r) => num(r, feat) !== null);
    if (withFeat.length < 2 * MIN_N_GATE) continue;
    const vals = withFeat.map((r) => num(r, feat)!).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const low = withFeat.filter((r) => num(r, feat)! < med);
    const high = withFeat.filter((r) => num(r, feat)! >= med);
    if (low.length < MIN_N_GATE || high.length < MIN_N_GATE) continue;
    const bLow = bucket(low);
    const bHigh = bucket(high);
    if (bLow.wr === null || bHigh.wr === null) continue;
    const delta = bHigh.wr - bLow.wr;
    const strongSide = delta >= DELTA_WR_GATE ? high : delta <= -DELTA_WR_GATE ? low : null;
    if (!strongSide) continue;
    const sideLabel = strongSide === high ? "high" : "low";
    const weak = strongSide === high ? low : high;
    const bStrong = strongSide === high ? bHigh : bLow;
    const bWeak = weak === high ? bHigh : bLow;
    if (bWeak.netUsd >= 0) continue; // only gate the side that costs money
    const gate: GateName = feat === "breakFrac" ? "min_break_frac" : feat === "riskPts" ? "max_risk" : "min_break_range";
    const value =
      feat === "riskPts"
        ? { maxRiskPts: med }
        : { min: med };
    const note =
      feat === "riskPts"
        ? `skip signals with risk above ${med.toFixed(1)} pts`
        : `require ${feat} >= ${med.toFixed(2)}`;
    out.push(
      validate(
        {
          strategy: "all",
          kind: "rule_proposal",
          severity: "info",
          title: `${feat} splits outcomes (${sideLabel} ≥ ${feat === "breakFrac" ? (med * 100).toFixed(0) + "%" : med.toFixed(2)} wins)`,
          finding: `${feat} ≥ median: ${pct(bStrong.wr)} win (${bStrong.n}) vs < median: ${pct(bWeak.wr)} (${bWeak.n}), ${usd(bWeak.netUsd)} net below.`,
          evidence: {
            feature: feat,
            median: med,
            lowN: bLow.n,
            lowWr: bLow.wr,
            highN: bHigh.n,
            highWr: bHigh.wr,
          },
          proposedAction: { family: "momentum", gate, value, note },
          autoApply: false,
        },
        strongSide === high ? low : high,
      ),
    );
  }

  // ---- 5. execution: adverse entry drift per family
  for (const [family, b] of byFamily) {
    if (b.n >= MIN_N_VETO && b.avgAdverse !== null && b.avgAdverse > 1.5) {
      out.push({
        strategy: family,
        kind: "execution",
        severity: "warn",
        title: `${family} entries fill ${b.avgAdverse.toFixed(1)} pts adverse on average`,
        finding: `Market orders land ${b.avgAdverse.toFixed(1)} pts worse than the signal close on average — entry drift is eating the edge.`,
        evidence: { n: b.n, avgAdversePts: b.avgAdverse },
        proposedAction: null,
        autoApply: false,
      });
    }
  }

  // ---- 6. first-of-day vs rest
  if (firstOfDay.n >= 4 && restOfDay.n >= 8) {
    if (firstOfDay.wr !== null && restOfDay.wr !== null && firstOfDay.wr - restOfDay.wr >= 0.15) {
      out.push({
        strategy: "all",
        kind: "observation",
        severity: "opportunity",
        title: "first card of the day carries the edge",
        finding: `First-of-day ${pct(firstOfDay.wr)} win (${firstOfDay.n}) vs rest-of-day ${pct(restOfDay.wr)} (${restOfDay.n}) — consistent with the replay research (77.2% vs ~74.5%).`,
        evidence: { firstWr: firstOfDay.wr, firstN: firstOfDay.n, restWr: restOfDay.wr, restN: restOfDay.n },
        proposedAction: null,
        autoApply: false,
      });
    }
  }

  // ---- 7. stop-run concentration (loss anatomy)
  for (const [family, b] of byFamily) {
    if (b.losses >= 4 && b.stopRuns === b.losses) {
      out.push({
        strategy: family,
        kind: "observation",
        severity: "warn",
        title: `${family}: every loss this window was a stop-run`,
        finding: `${b.stopRuns}/${b.losses} losses stopped within a tick of the extreme and price then moved in the trade direction — stop placement / entry location is the dominant loss mode.`,
        evidence: { losses: b.losses, stopRuns: b.stopRuns },
        proposedAction: null,
        autoApply: false,
      });
    }
  }

  // ---- 8. overall context (always emit, so the dashboard has a baseline)
  out.push({
    strategy: "all",
    kind: "observation",
    severity: "info",
    title: `baseline: ${rows.length} traded signals`,
    finding: `${overall.wins}W/${overall.losses}L (${pct(overall.wr)}), ${usd(overall.netUsd)} net, ${overall.stopRuns} stop-runs.`,
    evidence: { n: overall.n, wr: overall.wr, netUsd: overall.netUsd },
    proposedAction: null,
    autoApply: false,
  });

  return out;
}

function groupRows<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  }
  return m;
}

function hoursInBucket(bucketKey: string): number[] {
  switch (bucketKey) {
    case "globex_early":
      return [18, 19, 20];
    case "globex_core":
      return [21, 22, 23];
    case "globex_late":
      return [0, 1, 2];
    case "globex_dawn":
      return [3, 4, 5];
    case "premkt":
      return [6, 7, 8, 9];
    case "rth":
      return [10, 11, 12, 13, 14, 15];
    case "close":
      return [16, 17];
    default:
      return [];
  }
}

/** deterministic narrative used when no LLM is configured */
export function renderDeterministicNarrative(rows: AnalyzedTrade[], insights: Insight[]): string {
  const overall = bucket(rows);
  const byFamily = bucketStats(rows, (r) => canonicalFamily(r.family));
  const L: string[] = [];
  L.push(
    `Dataset: ${rows.length} traded signals — ${overall.wins}W/${overall.losses}L (${pct(overall.wr)}), ` +
      `${usd(overall.netUsd)} net, ${overall.stopRuns} stop-runs.`,
  );
  for (const [f, b] of byFamily) {
    if (b.n === 0) continue;
    L.push(`${f}: ${b.n} trades, ${pct(b.wr)}, ${usd(b.netUsd)} net, ${b.stopRuns}/${b.losses} losses were stop-runs.`);
  }
  const proposals = insights.filter((i) => i.kind === "rule_proposal");
  if (proposals.length) {
    L.push(`Proposals (${proposals.length}): ` + proposals.map((p) => p.title).join("; ") + ".");
  } else {
    L.push("No gate proposals this run — sample sizes below thresholds. Accumulating.");
  }
  return L.join("\n");
}
