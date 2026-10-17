/* ------------------------------------------------------------------ *
 * Promote from backtest — the one-command backtest→production path.
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/promoteFromBacktest.ts --report out.json [--apply] [--now]
 *
 * Reads a machine-readable study report (emitted by the named studies
 * via --report-json, see scripts/momentumStudy.ts), runs it through
 * the promotion contract (lib/promotionGate.ts), prints the verdict.
 *
 *   --apply  write the proposal as an insights row
 *            (source='backtest', auto_apply=true) — the nightly
 *            SELF_IMPROVE=1 arm applies it into strategy_overrides.
 *   --now    ALSO apply the strategy_overrides row immediately
 *            (the one-command path; requires --apply).
 *
 * Guardrails, all enforced by lib/promotionGate.ts:
 *   · suppressive override gates only (enable / hour_veto / trend_filter
 *     / min_break_frac / min_break_range / max_risk / first_only)
 *   · named-study allowlist, declared T0 Stack row, sample floors,
 *     test evidence, prop-sim PASS, grid DSR/PBO bars, 30% veto budget.
 *   · detector/env/risk knobs are NOT promotable here — they stay on
 *     the manual EXEC_CHANGE_POLICY path.
 * Auto-revert: the nightly edge monitor deactivates auto-applied rows
 * for a family on breach (scripts/strategyInsights.ts).
 *
 * A rejected contract exits 1 and writes nothing — the direct path
 * fails closed.
 * ------------------------------------------------------------------ */

import fs from "node:fs";
import { execSync } from "node:child_process";
import postgres from "postgres";
import { checkPromotion, type StudyReport } from "../lib/promotionGate";

function fail(msg: string): never {
  console.error(`promoteFromBacktest: ${msg}`);
  process.exit(2);
}

function sha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let reportPath = "";
  let apply = false;
  let now = false;
  const patch: Partial<StudyReport> = {};
  let gridJson = "";
  let valueJson = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") reportPath = argv[++i] ?? "";
    else if (a === "--apply") apply = true;
    else if (a === "--now") now = true;
    else if (a === "--family") patch.family = argv[++i] ?? "";
    else if (a === "--gate") patch.gate = (argv[++i] ?? "hour_veto") as StudyReport["gate"];
    else if (a === "--value") valueJson = argv[++i] ?? "";
    else if (a === "--note") patch.note = argv[++i] ?? "";
    else if (a === "--grid") gridJson = argv[++i] ?? "";
    else fail(`unknown arg ${a}`);
  }
  if (!reportPath) fail("usage: promoteFromBacktest.ts --report <report.json> [--family F] [--gate G] [--value JSON] [--note N] [--grid JSON] [--apply] [--now]");
  if (now && !apply) fail("--now requires --apply");

  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw) as StudyReport;
  if (valueJson) patch.value = JSON.parse(valueJson);
  if (gridJson) patch.grid = JSON.parse(gridJson);
  Object.assign(report, patch);
  if (!report.sha || report.sha === "unknown") report.sha = sha();

  console.log(`report: ${report.script} ${report.cli}`);
  console.log(`gate:   ${report.gate} → ${JSON.stringify(report.value)} (${report.family})`);
  console.log(`sha:    ${report.sha} · split ${report.splitDate}`);

  const verdict = checkPromotion(report);

  /* ---- promotion ledger: every verdict is recorded (pass AND reject),
   *      best-effort — a dry run without a DB still prints the verdict ---- */
  const DB_URL = process.env.DATABASE_URL;
  let runId: number | null = null;
  let sql: ReturnType<typeof postgres> | null = null;
  if (DB_URL) {
    try {
      sql = postgres(DB_URL, { ssl: "require", max: 1 });
      await sql`
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
        )`;
      const [row] = await sql`
        insert into promotion_runs (script, cli, sha, family, gate, value, verdict, reasons, note, applied)
        values (${report.script}, ${report.cli}, ${report.sha}, ${report.family}, ${report.gate},
                ${report.value === null ? null : JSON.stringify(report.value)}::jsonb,
                ${verdict.pass ? "passed" : "rejected"}, ${JSON.stringify(verdict.reasons)}::jsonb,
                ${report.note}, false)
        returning id`;
      runId = Number(row.id);
      console.log(`ledger run #${runId} recorded (${verdict.pass ? "passed" : "rejected"})`);
    } catch (e) {
      console.log(`ledger record skipped (${e instanceof Error ? e.message : e})`);
    }
  }

  if (!verdict.pass) {
    console.log("\nPROMOTION REJECTED — contract failures:");
    for (const r of verdict.reasons) console.log(`  ✗ ${r}`);
    if (sql) await sql.end().catch(() => {});
    process.exit(1);
  }
  console.log("\nPROMOTION PASSED — contract clean.");

  if (!apply) {
    console.log("(dry run — pass --apply to write the proposal, --now to also apply it)");
    if (sql) await sql.end().catch(() => {});
    return;
  }

  if (!DB_URL) fail("--apply needs DATABASE_URL (Neon). Nothing was written.");
  const db = sql!;
  try {
    const title = `backtest promotion: ${report.gate} on ${report.family} (${report.script})`;
    const existing = await db`
      select id, status from insights where title = ${title} and status in ('proposed', 'applied', 'reverted') limit 1`;
    if (existing.length > 0) {
      console.log(`insight already exists (id ${existing[0].id}, status ${existing[0].status}) — skipping insert (idempotent)`);
      if (runId !== null) await db`update promotion_runs set applied = true where id = ${runId}`;
      return;
    }
    const appliedAt = now ? "now()" : "null";
    const [ins] = await db`
      insert into insights (strategy, kind, severity, title, finding, evidence, proposed_action, auto_apply, status, source, run_at)
      values (${report.family}, 'rule_proposal', 'opportunity',
              ${title},
              ${report.note},
              ${JSON.stringify(report)}::jsonb,
              ${JSON.stringify({ family: report.family, gate: report.gate, value: report.value, note: report.note })}::jsonb,
              true, ${now ? "applied" : "proposed"}, 'backtest', now())
      returning id`;
    console.log(`insight #${ins.id} written (source=backtest, auto_apply=true)`);

    if (now) {
      await db`
        insert into strategy_overrides (insight_id, family, gate, value, active, note, applied_at)
        values (${Number(ins.id)}, ${report.family}, ${report.gate}, ${JSON.stringify(report.value)}::jsonb, true, ${report.note}, now())`;
      console.log(`strategy_overrides row applied — live within the feed's ~5 min cache`);
      if (runId !== null) await db`update promotion_runs set applied = true where id = ${runId}`;
    } else {
      console.log("proposal queued — the nightly SELF_IMPROVE=1 arm applies it (or approve in the dashboard)");
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("promoteFromBacktest:", e);
  process.exit(2);
});
