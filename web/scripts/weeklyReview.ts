/* ------------------------------------------------------------------ *
 * Weekly review CLI — the Saturday-morning self-improvement pass.
 *
 * Rolls up the trading week that just closed (Mon–Fri, New York
 * calendar) from Neon — realized trades, edge monitor, friction,
 * insights, the promotion ledger, live overrides — then re-runs the
 * promotion-contract studies against the frozen production stack and
 * records every verdict in `weekly_reviews` (one row per week). An LLM
 * narrative (same ANALYSIS_LLM_* plumbing as strategyInsights) writes
 * the week's story + next-week hypotheses; a Telegram summary card goes
 * out when configured.
 *
 * Auto-improve scope (owner-approved, RESEARCH-LOOP §5b + EXEC_CHANGE_POLICY):
 *   · Studies run through scripts/promoteFromBacktest.ts, so ONLY the
 *     suppressive override gates can be proposed (enable / hour_veto /
 *     trend_filter / min_break_frac / min_break_range / max_risk /
 *     first_only / side_veto / min_count_frac), contract-gated, with
 *     the edge monitor's auto-revert as the backstop.
 *   · WEEKLY_PROMOTE unset → dry-run: every verdict is recorded in the
 *     promotion ledger, nothing is proposed. Fails closed.
 *   · WEEKLY_PROMOTE=1     → contract-passed studies queue a proposal
 *     (insights row, auto_apply=true) for the existing dashboard-approve
 *     / nightly SELF_IMPROVE=1 path.
 *   · WEEKLY_PROMOTE=now   → ALSO apply immediately into
 *     strategy_overrides (live within ~5 min).
 *   Detector code, risk knobs, Coolify env, and the fill model are NEVER
 *   touched here — they stay on the manual EXEC_CHANGE_POLICY path.
 *
 * Env knobs (all optional, all default-off):
 *   WEEKLY_WEEK=YYYY-MM-DD   pick the target week (any date inside it)
 *   WEEKLY_STUDIES=names     comma list overriding the default queue
 *                            ("none" = rollup + narrative only)
 *   WEEKLY_MAX=N             append --max N to every study (smoke runs)
 *   WEEKLY_PROMOTE=1|now     promote contract-passed studies (see above)
 *   WEEKLY_GRID_DSR / WEEKLY_GRID_PBO  patch the countFracGateStudy
 *                            grid numbers from gcdata/validate_sweep.py
 *                            (without both, that report rejects on the
 *                            grid-discipline rule — honest, by design)
 *   WEEKLY_BUDGET_MIN=name=min,…  per-study advisory runtime budgets
 *                            (defaults: countFracGateStudy 20 · sideVeto
 *                            15 · hourExpectancy 15 — ~5× the measured
 *                            warm-cache runtimes; over-budget logs an
 *                            alarm + flags the row)
 *   WEEKLY_TG=0               skip the Telegram summary card
 *
 * Phase 3 — the next-week experiment queue:
 *   · the LLM answers with JSON { narrative, hypotheses }; hypotheses are
 *     sanitized (lib/weeklyReview.ts: catalog-only studies, no forbidden
 *     flags) and stored as weekly_experiments rows (status 'proposed');
 *   · the user queues experiments on /review (status 'queued');
 *   · on the next Saturday run the queued set REPLACES the default queue
 *     (WEEKLY_STUDIES still wins); studies without a --report-json
 *     emitter run research-only — recorded, never promoted;
 *   · each run updates the row: status 'ran' + verdict/reasons.
 *
 * Run (from web/):
 *   node --import ../scripts/ts-loader.mjs ./scripts/weeklyReview.ts
 * The Saturday cron wrapper is scripts/weekly.sh (repo root).
 * ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { aggregateTrades, familyOf, type EnrichedTrade } from "../lib/tradeStats";
import { edgeStatuses, type EdgeStatus } from "../lib/edgeMonitor";
import { etParts } from "../lib/marketHours";
import { coreStats, propViability, renderT1, renderT4, renderVerdict } from "../lib/backtestEngine";
import { sendTelegram } from "../lib/notify";
import { catalogPromptText, parseLlmPayload, budgetFor, parseBudgetEnv, buildAccountRollup, type AccountRollup, type ExperimentRow, type Hypothesis } from "../lib/weeklyReview";

/** repo paths anchored to this file — immune to the caller's cwd */
const WEB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // web/
const TS_LOADER = path.resolve(WEB_DIR, "..", "scripts", "ts-loader.mjs");

function loadEnvLocal() {
  const p = path.resolve(WEB_DIR, ".env.local");
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
  console.error("weeklyReview: need DATABASE_URL");
  process.exit(1);
}

const SCHEMA_SQL = `
create table if not exists weekly_reviews (
  id bigint generated always as identity primary key,
  week_start date not null unique,            -- Monday, New York calendar
  week_end date not null,                     -- Friday
  generated_at timestamptz not null default now(),
  sha text not null default '',
  stats jsonb not null default '{}'::jsonb,   -- the week rollup
  studies jsonb not null default '[]'::jsonb, -- queue results + verdicts + reports
  narrative text not null default '',
  narrative_source text not null default 'deterministic',
  telegram_sent boolean not null default false
);
create index if not exists weekly_reviews_generated_idx on weekly_reviews (generated_at desc);
-- the promotion ledger (same DDL as scripts/promoteFromBacktest.ts +
-- web/db/schema.sql — may not exist yet if the contract has never run)
create table if not exists promotion_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  script text not null,
  cli text not null default '',
  sha text not null default '',
  family text not null default '',
  gate text not null default '',
  value jsonb,
  verdict text not null check (verdict in ('passed', 'rejected')),
  reasons jsonb not null default '[]',
  note text not null default '',
  applied boolean not null default false
);
-- next-week experiment queue (Phase 3): the LLM proposes hypotheses →
-- weekly_experiments (status 'proposed'); the user queues them on /review;
-- the next Saturday job runs the queued set in place of the default queue.
create table if not exists weekly_experiments (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  week_start date not null,                 -- the review week that proposed it
  title text not null,
  study text not null,
  args jsonb not null default '[]'::jsonb,
  rationale text not null default '',
  status text not null default 'proposed' check (status in ('proposed', 'queued', 'ran', 'skipped')),
  source text not null default 'llm',
  ran_at timestamptz,
  review_id bigint,
  result jsonb
);
create index if not exists weekly_experiments_status_idx on weekly_experiments (status, id);
`;

/* ---------------- week window (New York calendar) ---------------- */

/** ms of 00:00 New-York time on an ET date string "YYYY-MM-DD". */
function etMidnightMs(dateStr: string): number {
  const utcNoon = Date.parse(`${dateStr}T12:00:00Z`);
  const p = etParts(utcNoon); // 07:00/08:00 NY on the same date (NY is behind UTC)
  const offsetHours = 12 - p.hour; // whole hours NY is behind UTC (4 EDT / 5 EST)
  return Date.parse(`${dateStr}T00:00:00Z`) + offsetHours * 3_600_000;
}

const etDateOf = (ms: number): string => {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};

/**
 * The trading week to review. Default: the most recent week whose Friday
 * has fully closed (the job runs Saturday morning). Any date inside the
 * target week picks it. Returns ET date strings + the [startMs, endMs)
 * ts range.
 */
function weekWindow(nowMs: number, override?: string): { start: string; end: string; startMs: number; endMs: number } {
  if (override) {
    const probe = Date.parse(`${override}T12:00:00Z`);
    if (!Number.isFinite(probe)) {
      console.error(`weeklyReview: bad WEEKLY_WEEK "${override}" — use YYYY-MM-DD`);
      process.exit(1);
    }
    const p = etParts(probe);
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.dow);
    const mondayMs = probe - ((dow + 6) % 7) * 86_400_000;
    const start = etDateOf(mondayMs);
    const end = etDateOf(mondayMs + 4 * 86_400_000);
    return { start, end, startMs: etMidnightMs(start), endMs: etMidnightMs(end) + 86_400_000 };
  }
  // walk back from yesterday until we hit a Friday (its week just closed)
  for (let back = 1; back <= 8; back++) {
    const p = etParts(nowMs - back * 86_400_000);
    if (p.dow === "Fri") {
      const fridayMs = nowMs - back * 86_400_000;
      const start = etDateOf(fridayMs - 4 * 86_400_000);
      const end = etDateOf(fridayMs);
      return { start, end, startMs: etMidnightMs(start), endMs: etMidnightMs(end) + 86_400_000 };
    }
  }
  console.error("weeklyReview: could not locate the previous Friday");
  process.exit(1);
}

/* ---------------- small helpers ---------------- */

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? n : null;
};

function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  try {
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
  } catch {
    return null;
  }
}

function sha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Best-effort query — tables owned by other jobs (insights,
 *  friction_daily, …) may not exist on a fresh database. */
async function guarded<T>(table: string, fn: () => Promise<T>): Promise<T | []> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[weekly] ${table} unavailable (${String(e)})`);
    return [];
  }
}

const sql = postgres(DB_URL, { max: 2, onnotice: () => {} });

/* ---------------- study queue (frozen production stack, one layer each) ---------------- */

type QueuedStudy = { name: string; script: string; args: string[] };

const DEFAULT_QUEUE: QueuedStudy[] = [
  {
    // the 2026-10-17 promoted min_count_frac gate — re-validated weekly
    // (report carries grid.variants=5 → contract rule 6 needs the
    // WEEKLY_GRID_DSR/WEEKLY_GRID_PBO patch from gcdata/validate_sweep.py)
    name: "countFracGateStudy",
    script: "./scripts/countFracGateStudy.ts",
    args: ["--offline", "--theta", "0.65"],
  },
  {
    // pre-registered side-veto candidate A (RESEARCH-LOOP §5b first scan)
    name: "sideVetoStudy",
    script: "./scripts/sideVetoStudy.ts",
    args: ["--family", "huge_bar_expansion", "--veto", '{"side":"short","hours":[15]}', "--offline"],
  },
];

function pickQueue(): QueuedStudy[] {
  const env = process.env.WEEKLY_STUDIES;
  if (!env) return DEFAULT_QUEUE;
  const names = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 1 && names[0].toLowerCase() === "none") return [];
  const known = new Map(DEFAULT_QUEUE.map((q) => [q.name, q]));
  const out: QueuedStudy[] = [];
  for (const n of names) {
    const q = known.get(n);
    if (!q) {
      console.log(`[weekly] WEEKLY_STUDIES: unknown study "${n}" — skipped (known: ${[...known.keys()].join(", ")})`);
      continue;
    }
    out.push(q);
  }
  return out;
}

type StudyResult = {
  name: string;
  cli: string;
  exit: number | null;
  verdict: "passed" | "rejected" | "error" | "research";
  reasons: string[];
  logTail: string;
  report: Record<string, unknown> | null;
  /** Phase 4 — runtime telemetry + advisory budget (minutes; the hard
   *  kill stays the 60-min subprocess timeout). */
  durationSec: number | null;
  budgetMin: number | null;
};

/** does this study script emit --report-json? (research-only studies run
 *  without it and are recorded, never promoted) */
const reportSupport = new Map<string, boolean>();
function supportsReportJson(script: string): boolean {
  const cached = reportSupport.get(script);
  if (cached !== undefined) return cached;
  try {
    const src = readFileSync(path.join(WEB_DIR, script), "utf8");
    reportSupport.set(script, src.includes("--report-json"));
  } catch {
    reportSupport.set(script, false);
  }
  return reportSupport.get(script)!;
}

/** Run one study (subprocess, offline) → report-json file. Never throws. */
function runStudy(q: QueuedStudy, tmpDir: string, withReport: boolean): { ok: boolean; exit: number | null; logTail: string; durationSec: number } {
  const reportPath = path.join(tmpDir, `${q.name}.json`);
  const args = [...q.args];
  if (process.env.WEEKLY_MAX) args.push("--max", process.env.WEEKLY_MAX);
  if (withReport) args.push("--report-json", reportPath);
  const cli = [q.script, ...args].join(" ");
  console.log(`[weekly] study ${cli}`);
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, ["--import", TS_LOADER, path.join(WEB_DIR, q.script), ...args], {
      cwd: WEB_DIR,
      timeout: 60 * 60_000,
      encoding: "utf8",
      env: process.env,
    });
    const sec = (Date.now() - t0) / 1000;
    console.log(`[weekly] study ${q.name} done in ${sec.toFixed(0)}s`);
    return { ok: true, exit: 0, logTail: out.trim(), durationSec: sec };
  } catch (e) {
    const err = e as { status?: number; signal?: string; stdout?: string; stderr?: string; message?: string };
    const tail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
    console.error(`[weekly] study ${q.name} FAILED (${err.signal ?? `status ${err.status}`}): ${err.message ?? ""}`);
    return { ok: false, exit: err.status ?? null, logTail: tail, durationSec: (Date.now() - t0) / 1000 };
  }
}

/**
 * Run one study's report through the promotion contract. Subprocess —
 * promoteFromBacktest owns the ledger + proposal writes (single source
 * of truth for the contract). Never throws.
 */
function contractCheck(
  reportPath: string,
  promoteMode: string,
  gridPatch: { dsr?: string; pbo?: string },
): { verdict: StudyResult["verdict"]; reasons: string[] } {
  const args = ["--import", TS_LOADER, path.join(WEB_DIR, "scripts", "promoteFromBacktest.ts"), "--report", reportPath];
  if (promoteMode === "now") args.push("--apply", "--now");
  else if (promoteMode === "1") args.push("--apply");
  if (gridPatch.dsr && gridPatch.pbo) {
    args.push("--grid", JSON.stringify({ variants: 5, dsr: Number(gridPatch.dsr), pbo: Number(gridPatch.pbo) }));
  }
  try {
    const out = execFileSync(process.execPath, args, { cwd: WEB_DIR, timeout: 120_000, encoding: "utf8", env: process.env });
    return { verdict: out.includes("PROMOTION PASSED") ? "passed" : "rejected", reasons: [] };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    const reasons = out
      .split("\n")
      .filter((l) => l.includes("✗"))
      .map((l) => l.replace(/^\s*✗\s*/, "").trim())
      .filter(Boolean);
    return { verdict: out.includes("PROMOTION REJECTED") ? "rejected" : "error", reasons };
  }
}

/* ---------------- the rollup (Neon) ---------------- */

async function loadTrades(start: string, end: string): Promise<Array<EnrichedTrade & { account: string }>> {
  const rows = await sql`
    select * from trades
    where status = 'matched' and day >= ${start} and day <= ${end}
    order by ts asc`;
  const out: Array<EnrichedTrade & { account: string }> = [];
  for (const r of rows) {
    const fillEntry = num(r.fill_entry);
    if (fillEntry === null) continue;
    const exitAvg = num(r.exit_avg) ?? fillEntry;
    const ef = parseJson<Array<{ ts: number }>>(r.exit_fills);
    const exitTs = ef && ef.length ? Math.max(...ef.map((f) => Number(f.ts))) : Number(r.ts);
    const sigEntry = num(r.sig_entry) ?? fillEntry;
    const sigStop = num(r.sig_stop) ?? fillEntry;
    const sigTarget = num(r.sig_target) ?? fillEntry;
    out.push({
      signalKey: String(r.signal_key),
      day: String(r.day),
      timeET: String(r.time_et),
      ts: Number(r.ts),
      side: String(r.side) === "long" ? "long" : "short",
      contracts: Number(r.contracts),
      verdict: String(r.verdict),
      sigEntry,
      sigStop,
      sigTarget,
      fillEntry,
      fillEntryAt: Date.parse(String(r.fill_entry_at ?? "")) || Number(r.ts),
      exitAvg,
      exitTs,
      grossUsd: num(r.gross_usd) ?? 0,
      netUsd: num(r.net_usd) ?? 0,
      commissions: num(r.commissions) ?? 0,
      result: r.result === "win" || r.result === "loss" ? r.result : "flat",
      family: String(r.family ?? ""),
      hourBucket: String(r.hour_bucket ?? ""),
      firstOfDay: !!r.first_of_day,
      riskPts: Math.abs(sigStop - sigEntry),
      targetPts: Math.abs(sigTarget - sigEntry),
      entryAdversePts: num(r.entry_adverse_pts) ?? 0,
      heldMin: num(r.held_min) ?? 0,
      mfePts: num(r.mfe_pts),
      maePts: num(r.mae_pts),
      targetReached: !!r.target_reached,
      recovered: !!r.recovered,
      stopRun: !!r.stop_run,
      lossLabel: (String(r.loss_label ?? "") as EnrichedTrade["lossLabel"]) || "",
      exitVsPlanPts: num(r.exit_vs_plan_pts),
      account: String(r.account ?? ""),
    });
  }
  return out;
}

/** Phase 3: the experiments the user queued on /review — these replace
 *  the default study queue on the next Saturday run. */
async function loadQueuedExperiments(): Promise<ExperimentRow[]> {
  try {
    const rows = (await sql`
      select id, created_at, week_start::text as week_start, title, study, args, rationale, status, source, ran_at, result
      from weekly_experiments where status = 'queued' order by id asc`) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      created_at: String(r.created_at),
      week_start: String(r.week_start),
      title: String(r.title),
      study: String(r.study),
      args: parseJson<string[]>(r.args) ?? [],
      rationale: String(r.rationale ?? ""),
      status: String(r.status) as ExperimentRow["status"],
      source: String(r.source ?? "llm"),
      ran_at: r.ran_at ? String(r.ran_at) : null,
      result: parseJson<ExperimentRow["result"]>(r.result),
    }));
  } catch (e) {
    console.warn(`[weekly] weekly_experiments unavailable (${String(e)})`);
    return [];
  }
}

/** Phase 3: persist the LLM's next-week hypotheses as 'proposed' rows
 *  (deduped by week + study + title — re-runs are idempotent). */
async function storeHypotheses(weekStart: string, hypotheses: Hypothesis[], source: string): Promise<number> {
  if (hypotheses.length === 0) return 0;
  const existing = (await sql`
    select study, title from weekly_experiments where week_start = ${weekStart} and source = ${source}`) as Array<{
    study: string;
    title: string;
  }>;
  const keys = new Set(existing.map((r) => `${r.study}|${r.title}`));
  let stored = 0;
  for (const h of hypotheses) {
    const key = `${h.study}|${h.title}`;
    if (keys.has(key)) continue;
    keys.add(key);
    await sql`
      insert into weekly_experiments (week_start, title, study, args, rationale, status, source)
      values (${weekStart}, ${h.title}, ${h.study}, ${sql.json(JSON.parse(JSON.stringify(h.args)))}, ${h.rationale}, 'proposed', ${source})`;
    stored++;
  }
  return stored;
}

async function main() {
  await sql.unsafe(SCHEMA_SQL);
  const jobStart = Date.now();
  const budgets = parseBudgetEnv(process.env.WEEKLY_BUDGET_MIN ?? "");
  const win = weekWindow(Date.now(), process.env.WEEKLY_WEEK);
  console.log(`[weekly] review week ${win.start} → ${win.end} (ts ${new Date(win.startMs).toISOString()} .. ${new Date(win.endMs).toISOString()})`);

  /* ---- A. week rollup ---- */
  const trades = await loadTrades(win.start, win.end);
  const statRows = aggregateTrades(trades);
  const overall = statRows.find((s) => s.group === "overall") ?? null;
  const families = statRows.filter((s) => s.group === "family" && s.n > 0);
  const edges = edgeStatuses(trades);
  console.log(`[weekly] ${trades.length} matched trades this week`);

  const sigRows = (await sql`
    select sent, count(*)::int as n from signals
    where ts >= ${win.startMs} and ts < ${win.endMs}
    group by sent`) as Array<{ sent: boolean; n: number }>;
  const sentN = sigRows.find((r) => r.sent)?.n ?? 0;
  const vetoedRows = (await sql`
    select verdict, count(*)::int as n from signals
    where sent = false and ts >= ${win.startMs} and ts < ${win.endMs}
    group by verdict order by n desc`) as Array<{ verdict: string; n: number }>;
  const vetoedByFamily = new Map<string, number>();
  for (const r of vetoedRows) {
    const f = familyOf(String(r.verdict ?? ""));
    vetoedByFamily.set(f, (vetoedByFamily.get(f) ?? 0) + Number(r.n));
  }
  const vetoedTotal = [...vetoedByFamily.values()].reduce((s, n) => s + n, 0);

  const friction = await guarded("friction_daily", async () => {
    return (await sql`select * from friction_daily where day >= ${win.start} and day <= ${win.end} order by day asc`) as unknown as Array<
      Record<string, unknown>
    >;
  });

  const weekInsights = await guarded("insights", async () => {
    return (await sql`
      select id, run_at, strategy, kind, severity, title, status, source from insights
      where run_at >= ${new Date(win.startMs).toISOString()} and run_at < ${new Date(win.endMs).toISOString()}
      order by run_at asc`) as Array<Record<string, unknown>>;
  });

  const weekPromotions = await guarded("promotion_runs", async () => {
    return (await sql`
      select id, run_at, script, family, gate, verdict, applied from promotion_runs
      where run_at >= ${new Date(win.startMs).toISOString()} and run_at < ${new Date(win.endMs).toISOString()}
      order by run_at asc`) as Array<Record<string, unknown>>;
  });

  const overrides = await guarded("strategy_overrides", async () => {
    return (await sql`
      select o.id, o.created_at, o.applied_at, o.family, o.gate, o.value, o.active, o.note, o.insight_id
      from strategy_overrides o order by o.created_at desc`) as Array<Record<string, unknown>>;
  });
  const activeOverrides = overrides.filter((o) => !!o.active);
  const autoReverts = overrides.filter((o) => String(o.note ?? "").startsWith("auto-revert:"));

  // per-account truth: matched bot trades × the reconcile's manual-fill
  // residual + the account-reported realized P&L (the broker portal number)
  const reconcileRuns = await guarded("reconcile_runs", async () => {
    return (await sql`
      select account, window_start, window_end, manual_fills, manual_gross_usd, account_net, account_realized
      from reconcile_runs
      where window_start >= ${new Date(win.startMs).toISOString()} and window_start < ${new Date(win.endMs).toISOString()}
      order by window_start asc, id asc`) as Array<Record<string, unknown>>;
  });
  const accounts = buildAccountRollup(trades as Array<Record<string, unknown>>, reconcileRuns);
  for (const a of accounts) {
    console.log(
      `[weekly] account ${a.account}: ${a.matched.n} bot trades net $${a.matched.netUsd.toFixed(2)} · ` +
        `${a.manual.fills} manual fills gross $${a.manual.grossUsd.toFixed(2)} · ` +
        `realized ${a.realizedUsd === null ? "—" : `$${a.realizedUsd.toFixed(2)}`}`,
    );
  }

  const summary = {
    week: `${win.start} → ${win.end}`,
    trades: { count: trades.length, overall, families },
    accounts,
    edges,
    signals: { sent: sentN, vetoedTotal, vetoedByFamily: [...vetoedByFamily.entries()].map(([family, n]) => ({ family, n })) },
    friction,
    insights: weekInsights,
    promotions: weekPromotions,
    overrides: { active: activeOverrides, autoReverts },
    runtime: { jobSec: null as number | null, studiesSec: null as number | null },
  };
  console.log(
    `[weekly] week rollup: ${trades.length} trades · ${sentN} cards sent · ${vetoedTotal} vetoed · ` +
      `${weekInsights.length} insights · ${weekPromotions.length} promotion runs · ${activeOverrides.length} active overrides`,
  );

  /* ---- B+C. study queue → promotion contract ---- */
  const promote = process.env.WEEKLY_PROMOTE ?? "";
  if (promote && promote !== "1" && promote !== "now") {
    console.error(`weeklyReview: WEEKLY_PROMOTE must be "1" or "now" (got "${promote}") — running dry`);
  }
  const promoteMode = promote === "1" || promote === "now" ? promote : "";
  const gridPatch = { dsr: process.env.WEEKLY_GRID_DSR, pbo: process.env.WEEKLY_GRID_PBO };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-review-"));

  /* ---- Phase 3: the user's queued experiments replace the default
   *      queue (WEEKLY_STUDIES still wins over everything) ---- */
  const queuedExperiments = await loadQueuedExperiments();
  const overrideEnv = process.env.WEEKLY_STUDIES;
  let queue: Array<QueuedStudy & { experimentId?: number }> = pickQueue();
  if (queuedExperiments.length > 0 && !overrideEnv) {
    queue = queuedExperiments.map((e) => ({ name: `exp-${e.id}`, script: e.study, args: e.args, experimentId: e.id }));
    console.log(`[weekly] ${queuedExperiments.length} queued experiment(s) replace the default queue`);
  } else if (queuedExperiments.length > 0) {
    console.log(`[weekly] WEEKLY_STUDIES override set — ${queuedExperiments.length} queued experiment(s) wait for the next run`);
  }

  const studies: StudyResult[] = [];
  const ranExperimentIds: number[] = [];
  let overBudget: string[] = [];
  for (const q of queue) {
    const withReport = supportsReportJson(q.script);
    const run = runStudy(q, tmpDir, withReport);
    const budgetMin = budgetFor(budgets, q.script);
    const base = {
      name: q.name,
      cli: [q.script, ...q.args].join(" "),
      exit: run.exit,
      report: null as Record<string, unknown> | null,
      durationSec: run.durationSec,
      budgetMin,
    };
    let result: StudyResult;
    if (!run.ok) {
      result = { ...base, verdict: "error", reasons: [`study failed (exit ${run.exit})`], logTail: run.logTail };
    } else if (!withReport) {
      // research-only study: recorded, never promoted — the promotion
      // contract remains the only path into strategy_overrides.
      result = { ...base, verdict: "research", reasons: [], logTail: run.logTail };
      console.log(`[weekly] research: ${q.name} done (no promotion — no report-json emitter)`);
    } else {
      const reportPath = path.join(tmpDir, `${q.name}.json`);
      let report: Record<string, unknown> | null = null;
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
      } catch {
        /* study wrote no report */
      }
      if (!report) {
        result = { ...base, verdict: "error", reasons: ["study exited 0 but wrote no report-json"], logTail: run.logTail };
      } else {
        const v = contractCheck(reportPath, promoteMode, gridPatch);
        result = { ...base, verdict: v.verdict, reasons: v.reasons, logTail: run.logTail, report };
        console.log(`[weekly] contract: ${q.name} → ${v.verdict}${v.reasons.length ? ` (${v.reasons.join("; ")})` : ""}`);
      }
    }
    // Phase 4: advisory runtime budget (warm-cache baseline × ~5) — an
    // over-budget run smells like a cold cache or a code regression.
    if (budgetMin !== null && run.durationSec > budgetMin * 60) {
      overBudget.push(`${q.name} ${(run.durationSec / 60).toFixed(1)}/${budgetMin} min`);
      console.warn(`[weekly] ⏱ ${q.name} took ${(run.durationSec / 60).toFixed(1)} min — over the ${budgetMin} min budget (cold cache? regression?)`);
    }
    studies.push(result);
    if (q.experimentId !== undefined) {
      await sql`
        update weekly_experiments
        set status = 'ran', ran_at = now(), result = ${sql.json(JSON.parse(JSON.stringify({ verdict: result.verdict, reasons: result.reasons, exit: result.exit, durationSec: Math.round(run.durationSec), budgetMin })))}
        where id = ${q.experimentId}`;
      ranExperimentIds.push(q.experimentId);
    }
  }
  if (queue.length === 0) console.log("[weekly] WEEKLY_STUDIES=none — rollup + narrative only");

  const studiesSec = studies.reduce((s, st) => s + (st.durationSec ?? 0), 0);
  summary.runtime.studiesSec = Math.round(studiesSec);
  console.log(
    `[weekly] study runtime: ${(studiesSec / 60).toFixed(1)} min total` +
      (overBudget.length ? ` · OVER BUDGET: ${overBudget.join(", ")}` : " · within budgets"),
  );

  /* ---- D. LLM narrative (proposes; never decides) — the response also
   *      carries the structured next-week hypotheses (Phase 3) ---- */
  const rawNarrative = await llmNarrative(summary, studies);
  const parsed = parseLlmPayload(rawNarrative.text);
  const narrativeSource = rawNarrative.from;
  const storedHypotheses = await storeHypotheses(win.start, parsed.hypotheses, narrativeSource);
  if (storedHypotheses > 0) console.log(`[weekly] stored ${storedHypotheses} new experiment hypothesis(es) for next week`);

  /* ---- E. persist (sql.json = real jsonb values; the stringify→parse
   *      roundtrip normalizes Dates and satisfies the JSONValue type) ---- */
  summary.runtime.jobSec = Math.round((Date.now() - jobStart) / 1000);
  const [reviewRow] = await sql`
    insert into weekly_reviews (week_start, week_end, generated_at, sha, stats, studies, narrative, narrative_source, telegram_sent)
    values (${win.start}, ${win.end}, now(), ${sha()}, ${sql.json(JSON.parse(JSON.stringify(summary)))}, ${sql.json(JSON.parse(JSON.stringify(studies)))}, ${parsed.narrative}, ${narrativeSource}, false)
    on conflict (week_start) do update
    set week_end = excluded.week_end, generated_at = now(), sha = excluded.sha,
        stats = excluded.stats, studies = excluded.studies,
        narrative = excluded.narrative, narrative_source = excluded.narrative_source
    returning id`;
  if (ranExperimentIds.length > 0) {
    await sql`update weekly_experiments set review_id = ${Number(reviewRow.id)} where id = any(${ranExperimentIds})`;
  }
  console.log(`[weekly] weekly_reviews row upserted for ${win.start}`);

  /* ---- F. Telegram summary (best-effort; WEEKLY_TG=0 skips) ---- */
  if (process.env.WEEKLY_TG !== "0") {
    const tg = await sendTelegram(telegramText(summary, studies), { parseMode: "HTML" });
    if (tg.sent) {
      await sql`update weekly_reviews set telegram_sent = true where week_start = ${win.start}`;
      console.log("[weekly] Telegram summary sent");
    } else {
      console.log(`[weekly] Telegram skipped (${tg.reason})`);
    }
  } else {
    console.log("[weekly] Telegram disabled (WEEKLY_TG=0)");
  }

  /* ---- standard report (realized week) ---- */
  const engineTrades = trades
    .filter((t) => t.contracts > 0 && t.riskPts > 0)
    .map((t) => ({ date: t.day, pnl: t.netUsd / (2 * t.contracts), risk: t.riskPts }));
  if (engineTrades.length) {
    const allStats = coreStats(engineTrades);
    console.log("\n=== STANDARD REPORT (realized week) ===");
    console.log(renderT1([{ label: "all", stats: allStats }]));
    const viability = propViability(engineTrades);
    console.log("\n" + renderT4(viability));
    console.log(
      "\n" +
        renderVerdict({
          edge: allStats.netPts > 0 && allStats.expR > 0 ? "real" : "absent",
          significance: "—",
          stability: "—",
          holdout: "n/a (live week)",
          viability:
            viability.pPass === null
              ? "n/a"
              : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
        }),
    );
  }

  console.log(`\n[weekly] done — ${win.start}: ${trades.length} trades, ${studies.map((s) => `${s.name}=${s.verdict}`).join(", ") || "no studies"}`);
  await sql.end();
}

/* ---------------- narrative ---------------- */

async function llmNarrative(summary: unknown, studies: StudyResult[]): Promise<{ from: "llm" | "deterministic"; text: string }> {
  const url = process.env.ANALYSIS_LLM_URL;
  const key = process.env.ANALYSIS_LLM_KEY;
  if (!url || !key) return { from: "deterministic", text: deterministicNarrative(summary, studies) };
  const model = process.env.ANALYSIS_LLM_MODEL ?? "deepseek-chat";
  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are the AI weekly-review analyst for an automated NQ (MNQ) scalping system. " +
          "You review the trading week that just closed (the window is stated in the data) plus the " +
          "promotion-contract study verdicts. Rules: state the week window explicitly in every verdict; " +
          "state sample sizes (n) for every claim; separate real P&L from vetoed/unfilled would-be numbers; " +
          "a short verdict per strategy family; the ONE highest-leverage improvement per strategy. " +
          "ACCOUNTS: the data carries a per-account rollup (accounts[]). Report PER ACCOUNT — every account's " +
          "bot-matched trades, manual-fill residual, and account-reported realized P&L as its own block, and " +
          "label the overall row as bot-matched trades only (it is NOT the account P&L). Never blend two " +
          "accounts into one number; state each account's name explicitly. " +
          "You never decide production changes — the promotion contract does; a rejected study is a rejected " +
          "study, not an invitation to hand-wave. Be skeptical of small samples. Concise markdown, no disclaimers.\n" +
          "RESPOND WITH A SINGLE JSON OBJECT AND NOTHING ELSE:\n" +
          '{"narrative": "<your markdown review>", "hypotheses": [{"title": "<short name>", "study": "<catalog path>", "args": ["<flag>", "..."], "rationale": "<why, one varying layer>"}]}\n' +
          "Propose 0–3 hypotheses for NEXT week's experiments. Every hypothesis must use ONLY a study from this catalog " +
          "and ONLY its documented flags — each experiment varies exactly ONE layer against the frozen production stack:\n" +
          catalogPromptText() +
          "\nIf no hypothesis is worth running, return an empty hypotheses array.",
      },
      {
        role: "user",
        content: JSON.stringify({ summary, studies: studies.map((s) => ({ name: s.name, verdict: s.verdict, reasons: s.reasons })) }),
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
      console.warn(`[weekly] LLM ${res.status} — falling back to deterministic narrative`);
      return { from: "deterministic", text: deterministicNarrative(summary, studies) };
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content;
    if (!text) return { from: "deterministic", text: deterministicNarrative(summary, studies) };
    return { from: "llm", text };
  } catch (e) {
    console.warn(`[weekly] LLM failed (${String(e)}) — deterministic narrative`);
    return { from: "deterministic", text: deterministicNarrative(summary, studies) };
  }
}

function deterministicNarrative(summary: unknown, studies: StudyResult[]): string {
  const s = summary as {
    week: string;
    trades: { count: number; overall: { n: number; wins: number; losses: number; netUsd: number; winRate: number | null } | null };
    accounts: AccountRollup[];
    edges: EdgeStatus[];
  };
  const o = s.trades.overall;
  const L: string[] = [
    `Week ${s.week}: ${s.trades.count} matched bot trades` +
      (o ? ` — ${o.wins}W/${o.losses}L${o.winRate !== null ? ` (${(o.winRate * 100).toFixed(1)}%)` : ""}, $${Math.round(o.netUsd)} net (bot-matched only, NOT account P&L).` : "."),
  ];
  for (const a of s.accounts ?? []) {
    L.push(
      `${a.account}: ${a.matched.n} bot trades net $${a.matched.netUsd.toFixed(2)} · ${a.manual.fills} manual fills gross $${a.manual.grossUsd.toFixed(2)}` +
        (a.realizedUsd !== null ? ` · account realized $${a.realizedUsd.toFixed(2)}` : ""),
    );
  }
  for (const e of s.edges) {
    if (e.status !== "insufficient") L.push(`edge ${e.family}: ${e.status.toUpperCase()} (${e.detail}).`);
  }
  if (studies.length) {
    L.push("Studies: " + studies.map((st) => `${st.name}=${st.verdict}${st.reasons.length ? ` (${st.reasons.join("; ")})` : ""}`).join(" · ") + ".");
  } else {
    L.push("No studies this week (WEEKLY_STUDIES=none).");
  }
  return L.join("\n");
}

/* ---------------- telegram card ---------------- */

function telegramText(summary: unknown, studies: StudyResult[]): string {
  const s = summary as {
    week: string;
    trades: { count: number; overall: { wins: number; losses: number; netUsd: number; stopRuns: number } | null };
    accounts: AccountRollup[];
    edges: EdgeStatus[];
  };
  const o = s.trades.overall;
  const L = [`<b>Weekly review ${s.week}</b>`];
  L.push(o ? `${s.trades.count} bot trades · ${o.wins}W/${o.losses}L · net $${Math.round(o.netUsd)} · ${o.stopRuns} stop-runs` : `${s.trades.count} bot trades`);
  for (const a of s.accounts ?? []) {
    L.push(
      `<b>${a.account}</b>: ${a.matched.n} bot trades net $${a.matched.netUsd.toFixed(2)}` +
        (a.manual.fills ? ` · ${a.manual.fills} manual fills gross $${a.manual.grossUsd.toFixed(2)}` : "") +
        (a.realizedUsd !== null ? ` · <b>account realized $${a.realizedUsd.toFixed(2)}</b>` : ""),
    );
  }
  for (const e of s.edges) {
    if (e.status !== "insufficient") L.push(`· ${e.family}: ${e.status.toUpperCase()}`);
  }
  if (studies.length) {
    L.push("Studies: " + studies.map((st) => `${st.name}=${st.verdict}`).join(", "));
    const over = studies.filter((st) => st.budgetMin !== null && st.durationSec !== null && st.durationSec > st.budgetMin * 60);
    if (over.length) {
      L.push(
        "⏱ over runtime budget: " +
          over.map((st) => `${st.name} ${(st.durationSec! / 60).toFixed(1)}/${st.budgetMin} min`).join(", ") +
          " (cold cache or regression?)",
      );
    }
  }
  return L.join("\n");
}

main().catch((e) => {
  console.error("[weekly] failed:", e);
  process.exit(1);
});
