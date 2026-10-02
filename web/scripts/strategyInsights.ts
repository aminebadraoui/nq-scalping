/* ------------------------------------------------------------------ *
 * Strategy insights CLI — the periodic "what could we improve" job.
 *
 * Loads the accumulated trade dataset (enriched `trades` rows with their
 * signal-time feature vectors), mines measurable win/loss patterns
 * (lib/strategyInsights.ts), and persists them as `insights` rows with
 * proposed gate changes. With SELF_IMPROVE=1 it auto-applies the strong
 * proposals (hour veto / trend filter) into `strategy_overrides` — the
 * live feed consults those every tick, so the system improves itself
 * without a deploy. Otherwise proposals wait for human approval on the
 * dashboard (Insights panel).
 *
 * AI narrative: when ANALYSIS_LLM_URL + ANALYSIS_LLM_KEY are configured
 * (OpenAI-compatible chat completions), the dataset summary + findings
 * are sent to the model for a per-strategy improvement narrative stored
 * as a narrative insight. Without them, a deterministic narrative is
 * stored instead — and the agent can be asked to do the deep-dive.
 *
 * Run from web/ (nightly.sh after tradeAnalysis, or manually):
 *   node --import ../scripts/ts-loader.mjs ./scripts/strategyInsights.ts
 *   node --import ../scripts/ts-loader.mjs ./scripts/strategyInsights.ts --since 2026-10-01T16:00:00Z
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  mineInsights,
  renderDeterministicNarrative,
  type AnalyzedTrade,
  type Insight,
} from "../lib/strategyInsights";
import { aggregateTrades } from "../lib/tradeStats";
import { edgeStatuses } from "../lib/edgeMonitor";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* env must be set by the caller */
  }
}
loadEnvLocal();

const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) {
  console.error("strategyInsights: need DATABASE_URL");
  process.exit(1);
}

const sinceArg = process.argv.indexOf("--since");
let since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
if (sinceArg >= 0 && process.argv[sinceArg + 1]) {
  const t = Date.parse(process.argv[sinceArg + 1]);
  if (!Number.isFinite(t)) {
    console.error(`strategyInsights: bad --since value "${process.argv[sinceArg + 1]}"`);
    process.exit(1);
  }
  since = new Date(t);
}

const sql = postgres(DB_URL, { max: 1 });

const SCHEMA_SQL = `
create table if not exists insights (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  strategy text not null,
  kind text not null,
  severity text not null default 'info',
  title text not null,
  finding text not null,
  evidence jsonb not null default '{}'::jsonb,
  proposed_action jsonb,
  auto_apply boolean not null default false,
  status text not null default 'proposed',
  source text not null default 'miner'
);
create index if not exists insights_status_idx on insights (status, run_at desc);
create table if not exists strategy_overrides (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  insight_id bigint,
  family text not null,
  gate text not null,
  value jsonb not null,
  active boolean not null default true,
  note text not null default ''
);
`;

function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  try {
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? n : null;
};

async function loadTrades(): Promise<AnalyzedTrade[]> {
  const rows = await sql`
    select * from trades
    where status = 'matched' and ts >= ${since.getTime()}
    order by ts asc`;
  const out: AnalyzedTrade[] = [];
  for (const r of rows) {
    const fillEntry = num(r.fill_entry);
    if (fillEntry === null) continue;
    const exitAvg = num(r.exit_avg) ?? fillEntry;
    let exitTs = fillEntryAt(r).getTime();
    const ef = parseJson<Array<{ ts: number }>>(r.exit_fills);
    if (ef && ef.length) exitTs = Math.max(...ef.map((f) => Number(f.ts)));
    out.push({
      signalKey: String(r.signal_key),
      day: String(r.day),
      timeET: String(r.time_et),
      ts: Number(r.ts),
      side: String(r.side) === "long" ? "long" : "short",
      contracts: Number(r.contracts),
      verdict: String(r.verdict),
      sigEntry: num(r.sig_entry) ?? fillEntry,
      sigStop: num(r.sig_stop) ?? fillEntry,
      sigTarget: num(r.sig_target) ?? fillEntry,
      fillEntry,
      fillEntryAt: fillEntryAt(r).getTime(),
      exitAvg,
      exitTs,
      grossUsd: num(r.gross_usd) ?? 0,
      netUsd: num(r.net_usd) ?? 0,
      commissions: num(r.commissions) ?? 0,
      result: r.result === "win" || r.result === "loss" ? r.result : "flat",
      family: String(r.family ?? ""),
      hourBucket: String(r.hour_bucket ?? ""),
      firstOfDay: !!r.first_of_day,
      riskPts: num(r.sig_stop) !== null && num(r.sig_entry) !== null ? Math.abs(num(r.sig_stop)! - num(r.sig_entry)!) : 0,
      targetPts: num(r.sig_target) !== null && num(r.sig_entry) !== null ? Math.abs(num(r.sig_target)! - num(r.sig_entry)!) : 0,
      entryAdversePts: num(r.entry_adverse_pts) ?? 0,
      heldMin: num(r.held_min) ?? 0,
      mfePts: num(r.mfe_pts),
      maePts: num(r.mae_pts),
      targetReached: !!r.target_reached,
      recovered: !!r.recovered,
      stopRun: !!r.stop_run,
      lossLabel: (String(r.loss_label ?? "") as AnalyzedTrade["lossLabel"]) || "",
      exitVsPlanPts: null,
      features: parseJson<Record<string, unknown>>(r.features),
    });
  }
  return out;
}

function fillEntryAt(r: Record<string, unknown>): Date {
  const v = r.fill_entry_at;
  if (v instanceof Date) return v;
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t) : new Date(Number(r.ts));
}

async function existingTitles(): Promise<Set<string>> {
  const rows = await sql`
    select title, status from insights
    where status in ('proposed', 'applied') and run_at >= ${new Date(Date.now() - 14 * 24 * 60 * 60_000)}`;
  return new Set(rows.map((r) => String(r.title)));
}

async function llmNarrative(rows: AnalyzedTrade[], insights: Insight[]): Promise<string | null> {
  const url = process.env.ANALYSIS_LLM_URL;
  const key = process.env.ANALYSIS_LLM_KEY;
  if (!url || !key) return null;
  const model = process.env.ANALYSIS_LLM_MODEL ?? "deepseek-chat";

  // ground the review in the same aggregates the dashboard shows
  const stats = aggregateTrades(rows).filter((s) => s.n > 0);
  const overall = stats.find((s) => s.group === "overall");
  const familyRows = stats.filter((s) => s.group === "family");
  const hourRows = stats.filter((s) => s.group === "hour");
  const sideRows = stats.filter((s) => s.group === "side");
  const tradeLines = rows.map((r) => {
    const flags = [r.stopRun ? "STOP-RUN" : "", r.targetReached ? "target-in-range" : "", r.recovered ? "recovered" : ""]
      .filter(Boolean)
      .join(",");
    return `${r.day} ${r.timeET} ${r.side.toUpperCase()} ${r.contracts} ${r.family} ${r.result.toUpperCase()} gross$${Math.round(
      r.grossUsd,
    )} net$${Math.round(r.netUsd)} drift${r.entryAdversePts.toFixed(1)} MFE${r.mfePts ?? "—"} MAE${r.maePts ?? "—"}${flags ? ` [${flags}]` : ""}`;
  });

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are the AI strategy analyst for an automated NQ (MNQ) scalping system. " +
          "Strategies: momentum failed-flush breakout (momentum_flush), momentum huge-bar expansion (momentum_expansion), " +
          "RTH soft-continuation (rth), open drive/pullback/sniper, sweep-reclaim. " +
          "Write a trading review from the data. IMPORTANT: the dataset is a ROLLING 30-DAY window ending now — " +
          "always state the window explicitly as a date range and separate TODAY's session numbers from the rolling-window " +
          "totals in every verdict, so a one-day P&L is never confused with the window total. Then: a short verdict per " +
          "strategy (what the numbers support vs what is noise, stating sample sizes explicitly), the ONE highest-leverage " +
          "improvement per strategy, and one concrete next experiment for the system (a gate, filter or execution change). " +
          "Mention stop-runs and adverse entry drift where relevant. Be skeptical of small samples. Concise markdown, no disclaimers.",
      },
      {
        role: "user",
        content: JSON.stringify({
          window: since.toISOString(),
          tradeCount: rows.length,
          overall: overall ?? null,
          byFamily: familyRows,
          byHour: hourRows,
          bySide: sideRows,
          findings: insights.map((i) => ({ severity: i.severity, kind: i.kind, title: i.title, finding: i.finding })),
          trades: tradeLines,
        }),
      },
    ],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[insights] LLM ${res.status} (${body.slice(0, 120)}) — falling back to deterministic narrative`);
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return j.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.warn(`[insights] LLM failed (${String(e)}) — deterministic narrative`);
    return null;
  }
}

async function main() {
  await sql.unsafe(SCHEMA_SQL);
  const trades = await loadTrades();
  console.log(`[insights] ${trades.length} analyzed trades since ${since.toISOString()}`);

  const insights = mineInsights(trades, { walkForward: process.env.INSIGHTS_WALK_FORWARD !== "0" });
  const known = await existingTitles();

  let stored = 0;
  for (const i of insights) {
    if (known.has(i.title)) continue;
    known.add(i.title);
    await sql`
      insert into insights (strategy, kind, severity, title, finding, evidence, proposed_action, auto_apply, status, source)
      values (${i.strategy}, ${i.kind}, ${i.severity}, ${i.title}, ${i.finding},
              ${JSON.stringify(i.evidence)}, ${i.proposedAction ? JSON.stringify(i.proposedAction) : null},
              ${i.autoApply}, 'proposed', 'miner')`;
    stored++;
  }

  // ---- self-improvement: auto-apply strong proposals when armed ----
  if (process.env.SELF_IMPROVE === "1") {
    const pending = await sql`
      select * from insights where status = 'proposed' and auto_apply = true and proposed_action is not null`;
    for (const p of pending) {
      const action = parseJson<{ family: string; gate: string; value: unknown; note: string }>(p.proposed_action);
      if (!action) continue;
      await sql`
        insert into strategy_overrides (insight_id, family, gate, value, active, note, applied_at)
        values (${Number(p.id)}, ${action.family}, ${action.gate}, ${JSON.stringify(action.value)}, true, ${action.note}, now())`;
      await sql`update insights set status = 'applied' where id = ${Number(p.id)}`;
      console.log(`[insights] SELF-IMPROVE applied: ${String(p.title)}`);
    }
  }

  // ---- edge monitor (live expR vs replay baseline per family) ----
  const edges = edgeStatuses(trades);
  for (const e of edges) {
    await sql`
      insert into insights (strategy, kind, severity, title, finding, evidence, status, source)
      values (${e.family}, 'edge_monitor',
              ${e.status === "breach" ? "warn" : e.status === "watch" ? "warn" : "info"},
              ${`edge monitor: ${e.family}`}, ${e.detail},
              ${JSON.stringify({ n: e.n, meanExpR: e.meanExpR, baselineExpR: e.baselineExpR, status: e.status })},
              ${e.status}, 'miner')`;
    console.log(`  EDGE ${e.status.toUpperCase().padEnd(11)} ${e.family}: ${e.detail}`);
  }

  // ---- AI narrative ----
  const narrative = (await llmNarrative(trades, insights)) ?? renderDeterministicNarrative(trades, insights);
  await sql`
    insert into insights (strategy, kind, severity, title, finding, evidence, status, source)
    values ('all', 'narrative', 'info', 'AI strategy review', ${narrative}, ${JSON.stringify({
      trades: trades.length,
      windowStart: since.toISOString(),
    })}, 'proposed', ${process.env.ANALYSIS_LLM_KEY ? 'llm' : 'deterministic'})`;

  console.log(`[insights] stored ${stored} new findings + 1 narrative`);
  for (const i of insights) {
    const tag = i.proposedAction
      ? `  → [${i.proposedAction.family}.${i.proposedAction.gate}] ${i.proposedAction.note}${i.autoApply ? " (auto)" : ""}`
      : "";
    console.log(`  ${i.severity.toUpperCase().padEnd(11)} ${i.title}${tag}`);
  }
  console.log(`\n${narrative}\n`);
  await sql.end();
}

main().catch((e) => {
  console.error("[insights] failed:", e);
  process.exit(1);
});
