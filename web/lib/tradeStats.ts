/* ------------------------------------------------------------------ *
 * Trade analysis framework — the win/loss post-mortem as a repeatable
 * pipeline (not a one-off review).
 *
 * Input: reconciled trades (lib/scripts/reconcileTrades.ts output —
 * signal card joined with its CrossTrade fills) plus the minute bars
 * the trade lived through (Neon `candles_1m`, live-written by the VPS).
 *
 * Per trade it computes the execution anatomy:
 *   · entry adverse drift   — how much worse than the signal price we
 *                             filled (positive = worse)
 *   · MFE / MAE             — max favorable / adverse excursion in pts
 *                             from the fill entry, over the bars we held
 *   · target_reached        — MFE reached the signal target zone before
 *                             the trade ended (a loss with MFE ≥ target
 *                             "would have won")
 *   · recovered             — on a loss, price crossed back through our
 *                             entry in the trade direction within 15 min
 *                             of the exit (the "stopped at the exact
 *                             extreme" fingerprint)
 *   · stop_run              — loss AND (target_reached OR recovered)
 *   · loss_label            — 'stop-run' | 'never worked' | 'gave back'
 *
 * Aggregate layer: win/loss stats per group — overall, strategy family,
 * momentum trigger (failed-flush vs huge-bar expansion), hour bucket,
 * side, and first-of-day vs the rest. Pure functions, unit-tested:
 * the CLI (scripts/tradeAnalysis.ts) feeds them rows and persists the
 * summary; the dashboard reads the summary through /api/trades.
 * ------------------------------------------------------------------ */

export type TradeForAnalysis = {
  signalKey: string;
  day: string;
  timeET: string; // "HH:mm" New York
  ts: number; // signal record ts (epoch ms)
  side: "long" | "short";
  contracts: number;
  verdict: string;
  sigEntry: number;
  sigStop: number;
  sigTarget: number;
  fillEntry: number;
  fillEntryAt: number; // epoch ms
  exitAvg: number;
  exitTs: number; // epoch ms (last exit fill)
  grossUsd: number;
  netUsd: number;
  commissions: number;
  result: "win" | "loss" | "flat";
};

export type Bar = { ts: number; high: number; low: number }; // ts = epoch ms

export const MINUTE = 60_000;

/* ---- strategy family ---------------------------------------------- */

/** Map a signal verdict to the strategy family the analysis groups by.
 *  Accepts BOTH the pre-2026-10-19 rename phrases ("momentum (huge-bar
 *  expansion)", "rth soft-continuation", …) and the new expressive ones —
 *  historical rows must keep bucketing correctly forever. */
export function familyOf(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v.includes("huge-bar expansion")) return "huge_bar_expansion";
  if (v.includes("failed-flush") || v.includes("big-bar") || v.includes("momentum")) return "failed_flush_breakout";
  if (v.includes("session continuation") || v.includes("rth")) return "session_continuation";
  if (v.includes("open drive")) return "open_drive";
  if (v.includes("open pullback")) return "open_pullback";
  if (v.includes("open sniper")) return "open_sniper";
  if (v.includes("sweep-reclaim")) return "sweep_reclaim";
  if (v.includes("reversal")) return "lvn_reversal"; // the retired LVN reversal box
  return "other";
}

/* ---- hour buckets -------------------------------------------------- */

/** hypothetical win rate by family over the ALL-SIGNALS universe: every
 *  recorded card's replay outcome (win/loss only — time/open don't
 *  decide). The signal-quality complement to the filled-only scoreboard:
 *  a family whose hyp WR is far above its filled WR is being filtered
 *  or executed badly; the reverse means the gates add value. */
export function hypWrByFamily(
  sigs: Array<{ verdict: string; outcome: string }>,
): Map<string, { n: number; wins: number; wr: number }> {
  const by = new Map<string, { n: number; wins: number }>();
  for (const s of sigs) {
    if (s.outcome !== "win" && s.outcome !== "loss") continue;
    const f = familyOf(s.verdict);
    const e = by.get(f) ?? { n: 0, wins: 0 };
    e.n++;
    if (s.outcome === "win") e.wins++;
    by.set(f, e);
  }
  return new Map([...by.entries()].map(([f, e]) => [f, { n: e.n, wins: e.wins, wr: e.n > 0 ? e.wins / e.n : 0 }]));
}

export function hourBucketOf(timeET: string): string {
  const h = Number.parseInt(timeET.slice(0, 2), 10);
  const m = Number.parseInt(timeET.slice(3, 5), 10);
  if (!Number.isFinite(h)) return "unknown";
  if (h >= 18 && h <= 20) return "globex_early"; // 18:00–20:59
  if (h >= 21 && h <= 23) return "globex_core"; // 21:00–23:59
  if (h >= 0 && h <= 2) return "globex_late"; // 00:00–02:59
  if (h >= 3 && h <= 5) return "globex_dawn"; // 03:00–05:59
  if (h === 9 && m < 30) return "premkt"; // 09:00–09:29
  if (h >= 6 && h < 9) return "premkt";
  if ((h === 9 && m >= 30) || (h >= 10 && h <= 15)) return "rth"; // 09:30–15:59
  return "close"; // 16:00–17:59
}

/* ---- per-trade features -------------------------------------------- */

export type TradeFeatures = {
  family: string;
  hourBucket: string;
  firstOfDay: boolean;
  riskPts: number; // |sigStop - sigEntry| — the designed risk
  targetPts: number; // |sigTarget - sigEntry|
  entryAdversePts: number; // (fillEntry - sigEntry) × dir — positive = filled worse
  heldMin: number;
  mfePts: number | null; // max favorable excursion from fillEntry (null = no bars)
  maePts: number | null; // max adverse excursion from fillEntry
  targetReached: boolean; // MFE within a tick of the signal target
  recovered: boolean; // loss, then price crossed back through entry ≤15 min
  stopRun: boolean; // loss AND (targetReached OR recovered)
  lossLabel: "" | "stop-run" | "never worked" | "gave back";
  exitVsPlanPts: number | null; // positive = exited better than the plan (target for wins, stop for losses)
};

const RECOVERY_WINDOW_MS = 15 * MINUTE;
const TICK = 0.25;

/**
 * Anatomy of one reconciled trade against the minute bars it lived through.
 * Bars from the entry minute through the exit are used (approximation: the
 * entry bar includes prints from before the fill). `firstOfDay` is computed
 * by the caller (first traded signal of the session day, any family).
 */
export function computeFeatures(
  t: TradeForAnalysis,
  bars: Bar[],
  firstOfDay: boolean,
): TradeFeatures {
  const dir = t.side === "long" ? 1 : -1;
  const riskPts = Math.abs(t.sigStop - t.sigEntry);
  const targetPts = Math.abs(t.sigTarget - t.sigEntry);
  const entryAdversePts = (t.fillEntry - t.sigEntry) * dir;
  const heldMin = Math.max(0, (t.exitTs - t.fillEntryAt) / MINUTE);

  // bars during the trade: entry minute → exit minute (inclusive)
  const entryBarStart = Math.floor(t.fillEntryAt / MINUTE) * MINUTE;
  let mfe: number | null = null;
  let mae: number | null = null;
  for (const b of bars) {
    if (b.ts < entryBarStart || b.ts > t.exitTs) continue;
    const fav = dir === 1 ? b.high - t.fillEntry : t.fillEntry - b.low;
    const adv = dir === 1 ? t.fillEntry - b.low : b.high - t.fillEntry;
    if (mfe === null || fav > mfe) mfe = fav;
    if (mae === null || adv > mae) mae = adv;
  }
  if (mfe !== null && mfe < 0) mfe = 0;
  if (mae !== null && mae < 0) mae = 0;

  const targetReached = mfe !== null && mfe >= targetPts - TICK;

  // recovery: after the exit, price crossed back through the entry in the
  // trade direction within RECOVERY_WINDOW_MS
  let recovered = false;
  if (t.result === "loss") {
    for (const b of bars) {
      if (b.ts <= t.exitTs || b.ts > t.exitTs + RECOVERY_WINDOW_MS) continue;
      if ((dir === 1 && b.high >= t.fillEntry) || (dir === -1 && b.low <= t.fillEntry)) {
        recovered = true;
        break;
      }
    }
  }

  const stopRun = t.result === "loss" && (targetReached || recovered);
  const lossLabel: TradeFeatures["lossLabel"] =
    t.result !== "loss"
      ? ""
      : stopRun
        ? "stop-run"
        : mfe !== null && mfe < 0.4 * targetPts
          ? "never worked"
          : "gave back";

  // how the actual exit compares to the plan: target (wins) / stop (losses)
  let exitVsPlanPts: number | null = null;
  if (t.exitAvg > 0) {
    const plan = t.result === "win" ? t.fillEntry + dir * targetPts : t.fillEntry - dir * riskPts;
    exitVsPlanPts = (t.exitAvg - plan) * dir; // positive = better than planned
  }

  return {
    family: familyOf(t.verdict),
    hourBucket: hourBucketOf(t.timeET),
    firstOfDay,
    riskPts,
    targetPts,
    entryAdversePts,
    heldMin,
    mfePts: mfe,
    maePts: mae,
    targetReached,
    recovered,
    stopRun,
    lossLabel,
    exitVsPlanPts,
  };
}

/* ---- aggregates ---------------------------------------------------- */

export type StatRow = {
  group: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null; // null when n = 0
  grossUsd: number;
  netUsd: number;
  commissions: number;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  expectancyUsd: number | null; // net per trade
  stopRuns: number;
  stopRunRate: number | null; // share of LOSSES that were stop-runs
  avgEntryAdversePts: number | null;
  avgMfePts: number | null;
  avgMaePts: number | null;
};

function emptyRow(group: string, label: string): StatRow {
  return {
    group,
    label,
    n: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    grossUsd: 0,
    netUsd: 0,
    commissions: 0,
    profitFactor: null,
    avgWinUsd: null,
    avgLossUsd: null,
    expectancyUsd: null,
    stopRuns: 0,
    stopRunRate: null,
    avgEntryAdversePts: null,
    avgMfePts: null,
    avgMaePts: null,
  };
}

export type EnrichedTrade = TradeForAnalysis & TradeFeatures;

export function aggregateTrades(rows: EnrichedTrade[]): StatRow[] {
  const wins = (g: EnrichedTrade[]) => g.filter((r) => r.result === "win");
  const losses = (g: EnrichedTrade[]) => g.filter((r) => r.result === "loss");

  const build = (group: string, label: string, g: EnrichedTrade[]): StatRow => {
    const row = emptyRow(group, label);
    row.n = g.length;
    const w = wins(g);
    const l = losses(g);
    row.wins = w.length;
    row.losses = l.length;
    row.winRate = row.n ? row.wins / row.n : null;
    row.grossUsd = g.reduce((s, r) => s + r.grossUsd, 0);
    row.netUsd = g.reduce((s, r) => s + r.netUsd, 0);
    row.commissions = g.reduce((s, r) => s + r.commissions, 0);
    const grossWins = w.reduce((s, r) => s + r.grossUsd, 0);
    const grossLosses = -l.reduce((s, r) => s + r.grossUsd, 0);
    row.profitFactor =
      grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Number.POSITIVE_INFINITY : null;
    row.avgWinUsd = w.length ? grossWins / w.length : null;
    row.avgLossUsd = l.length ? grossLosses / l.length : null;
    row.expectancyUsd = row.n ? row.netUsd / row.n : null;
    row.stopRuns = l.filter((r) => r.stopRun).length;
    row.stopRunRate = l.length ? row.stopRuns / l.length : null;
    const adv = g.filter((r) => Number.isFinite(r.entryAdversePts));
    row.avgEntryAdversePts = adv.length ? adv.reduce((s, r) => s + r.entryAdversePts, 0) / adv.length : null;
    const mfe = g.filter((r) => r.mfePts !== null);
    row.avgMfePts = mfe.length ? mfe.reduce((s, r) => s + (r.mfePts ?? 0), 0) / mfe.length : null;
    const mae = g.filter((r) => r.maePts !== null);
    row.avgMaePts = mae.length ? mae.reduce((s, r) => s + (r.maePts ?? 0), 0) / mae.length : null;
    return row;
  };

  const out: StatRow[] = [];
  out.push(build("overall", "all strategies", rows));

  for (const [family, g] of groupBy(rows, (r) => r.family)) {
    out.push(build("family", family, g));
    if (family === "failed_flush_breakout" || family === "huge_bar_expansion") {
      // momentum sub-group already covered by family rows above
    }
  }
  for (const [bucket, g] of groupBy(rows, (r) => r.hourBucket)) {
    out.push(build("hour", bucket, g));
  }
  for (const [side, g] of groupBy(rows, (r) => r.side)) {
    out.push(build("side", side, g));
  }
  out.push(build("first", "first of day", rows.filter((r) => r.firstOfDay)));
  out.push(build("first", "rest of day", rows.filter((r) => !r.firstOfDay)));
  const stopRuns = rows.filter((r) => r.stopRun);
  out.push(build("lossclass", "losses: stop-run", stopRuns));
  out.push(build("lossclass", "losses: never worked", rows.filter((r) => r.lossLabel === "never worked")));
  out.push(build("lossclass", "losses: gave back", rows.filter((r) => r.lossLabel === "gave back")));
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  }
  return m;
}

/** first traded signal of the session day (any family), by signal ts */
export function markFirstOfDay(rows: { day: string; ts: number }[]): Set<number> {
  const firstTs = new Map<string, number>();
  for (const r of rows) {
    const cur = firstTs.get(r.day);
    if (cur === undefined || r.ts < cur) firstTs.set(r.day, r.ts);
  }
  return new Set([...firstTs.values()]);
}

/* ---- report rendering ---------------------------------------------- */

export function renderReport(rows: EnrichedTrade[], stats: StatRow[]): string {
  const L: string[] = [];
  const fmtUsd = (n: number | null, dp = 0) =>
    n === null ? "—" : `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(dp)}`;
  const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
  const pts = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`);

  L.push(`# Trade analysis — ${rows.length} traded signals`);
  L.push("");
  L.push("| group | n | WR | PF | gross | net | avg win | avg loss | exp | stop-runs | drift | MFE | MAE |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of stats) {
    if (s.n === 0) continue;
    L.push(
      `| ${s.group === "overall" ? "ALL" : `${s.group}:`} ${s.label} | ${s.n} | ${pct(s.winRate)} | ` +
        `${s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)} | ${fmtUsd(s.grossUsd)} | ${fmtUsd(s.netUsd)} | ` +
        `${fmtUsd(s.avgWinUsd)} | ${fmtUsd(s.avgLossUsd)} | ${fmtUsd(s.expectancyUsd)} | ` +
        `${s.stopRuns} (${pct(s.stopRunRate)} of losses) | ${pts(s.avgEntryAdversePts)} | ${pts(s.avgMfePts)} | ${pts(s.avgMaePts)} |`,
    );
  }

  L.push("");
  L.push("## per-trade anatomy");
  L.push("");
  for (const r of rows) {
    const flags = [
      r.stopRun ? "⛔ STOP-RUN" : "",
      r.targetReached ? "🎯 target in range" : "",
      r.recovered ? "↩ recovered after exit" : "",
      r.lossLabel === "never worked" ? "✗ never worked" : "",
      r.lossLabel === "gave back" ? "↺ gave back" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    L.push(
      `- ${r.day} ${r.timeET} **${r.side.toUpperCase()} ${r.contracts}** ${r.family} · ${r.result.toUpperCase()} ` +
        `${fmtUsd(r.grossUsd)} (net ${fmtUsd(r.netUsd)}) · drift ${pts(r.entryAdversePts)} · held ${r.heldMin.toFixed(0)}m · ` +
        `MFE ${pts(r.mfePts)} · MAE ${pts(r.maePts)}${flags ? ` · ${flags}` : ""}`,
    );
  }
  return L.join("\n");
}
