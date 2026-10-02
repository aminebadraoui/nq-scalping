/* ------------------------------------------------------------------ *
 * Trade analysis CLI — the win/loss post-mortem as a nightly job.
 *
 * Reads the reconciled `trades` rows (scripts/reconcileTrades.ts),
 * computes each trade's execution anatomy against the minute bars it
 * lived through (lib/tradeStats.ts), persists the per-trade features
 * back onto `trades` and the aggregate summary into `trade_analysis`,
 * then prints the report.
 *
 * Run from web/ (nightly.sh after reconcile, or manually):
 *   node --import ../scripts/ts-loader.mjs ./scripts/tradeAnalysis.ts
 *   node --import ../scripts/ts-loader.mjs ./scripts/tradeAnalysis.ts --since 2026-10-01T16:00:00Z
 *
 * Idempotent: per-trade features are recomputed in place; `trade_analysis`
 * rows append (the dashboard reads the newest).
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  computeFeatures,
  aggregateTrades,
  markFirstOfDay,
  renderReport,
  type TradeForAnalysis,
  type EnrichedTrade,
} from "../lib/tradeStats";

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
  console.error("tradeAnalysis: need DATABASE_URL");
  process.exit(1);
}

const MINUTE = 60_000;
const sinceArg = process.argv.indexOf("--since");
let since = new Date(Date.now() - 30 * 24 * 60 * MINUTE);
if (sinceArg >= 0 && process.argv[sinceArg + 1]) {
  const t = Date.parse(process.argv[sinceArg + 1]);
  if (!Number.isFinite(t)) {
    console.error(`tradeAnalysis: bad --since value "${process.argv[sinceArg + 1]}"`);
    process.exit(1);
  }
  since = new Date(t);
}

const sql = postgres(DB_URL, { max: 1 });

const SCHEMA_SQL = `
alter table trades add column if not exists family text not null default '';
alter table trades add column if not exists hour_bucket text not null default '';
alter table trades add column if not exists first_of_day boolean not null default false;
alter table trades add column if not exists entry_adverse_pts numeric(10,2);
alter table trades add column if not exists held_min numeric(10,2);
alter table trades add column if not exists mfe_pts numeric(10,2);
alter table trades add column if not exists mae_pts numeric(10,2);
alter table trades add column if not exists target_reached boolean not null default false;
alter table trades add column if not exists recovered boolean not null default false;
alter table trades add column if not exists stop_run boolean not null default false;
alter table trades add column if not exists loss_label text not null default '';
create table if not exists trade_analysis (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  window_start timestamptz not null,
  window_end timestamptz not null,
  trades_n int not null default 0,
  summary jsonb not null default '[]'::jsonb
);
`;

type TradeDbRow = Record<string, unknown> & {
  signal_key: string;
  day: string;
  time_et: string;
  ts: string;
  side: string;
  contracts: number;
  verdict: string;
  sig_entry: string | null;
  sig_stop: string | null;
  sig_target: string | null;
  fill_entry: string | null;
  fill_entry_at: Date | null;
  exit_avg: string | null;
  exit_fills: unknown;
  gross_usd: string;
  net_usd: string;
  commissions: string;
  result: string;
};

function toAnalysis(row: TradeDbRow): TradeForAnalysis | null {
  if (row.fill_entry === null || row.sig_entry === null || row.sig_stop === null || row.sig_target === null) {
    return null;
  }
  let exitFillsRaw: unknown = row.exit_fills;
  if (typeof exitFillsRaw === "string") {
    try {
      exitFillsRaw = JSON.parse(exitFillsRaw);
    } catch {
      exitFillsRaw = null;
    }
  }
  const exitFills = Array.isArray(exitFillsRaw)
    ? (exitFillsRaw as Array<{ ts: number }>)
    : [];
  const exitTs = exitFills.length
    ? Math.max(...exitFills.map((f) => Number(f.ts)))
    : row.fill_entry_at
      ? new Date(row.fill_entry_at).getTime()
      : Number(row.ts);
  return {
    signalKey: row.signal_key,
    day: row.day,
    timeET: row.time_et,
    ts: Number(row.ts),
    side: row.side === "long" ? "long" : "short",
    contracts: Number(row.contracts),
    verdict: row.verdict,
    sigEntry: Number(row.sig_entry),
    sigStop: Number(row.sig_stop),
    sigTarget: Number(row.sig_target),
    fillEntry: Number(row.fill_entry),
    fillEntryAt: row.fill_entry_at ? new Date(row.fill_entry_at).getTime() : Number(row.ts),
    exitAvg: row.exit_avg ? Number(row.exit_avg) : Number(row.fill_entry),
    exitTs,
    grossUsd: Number(row.gross_usd),
    netUsd: Number(row.net_usd),
    commissions: Number(row.commissions),
    result: row.result === "win" || row.result === "loss" ? row.result : "flat",
  };
}

async function main() {
  await sql.unsafe(SCHEMA_SQL);

  const rows = (await sql`
    select * from trades
    where status = 'matched' and ts >= ${since.getTime()}
    order by ts asc`) as unknown as TradeDbRow[];

  const trades = rows.map(toAnalysis).filter((t): t is TradeForAnalysis => t !== null);
  console.log(`[tradeAnalysis] window since ${since.toISOString()} · ${trades.length} matched trades`);

  // minute bars for the whole covered range (live-written by the VPS; gaps → null MFE/MAE)
  let bars: { ts: number; high: number; low: number }[] = [];
  if (trades.length) {
    const minTs = Math.min(...trades.map((t) => t.fillEntryAt));
    const maxTs = Math.max(...trades.map((t) => t.exitTs)) + 16 * MINUTE;
    const barRows = (await sql`
      select ts, h, l from candles_1m
      where ts >= ${new Date(minTs)} and ts <= ${new Date(maxTs)}
      order by ts asc`) as unknown as { ts: Date; h: string; l: string }[];
    bars = barRows.map((b) => ({ ts: new Date(b.ts).getTime(), high: Number(b.h), low: Number(b.l) }));
  }

  const firstSet = markFirstOfDay(trades);
  const enriched: EnrichedTrade[] = trades.map((t) => {
    const f = computeFeatures(t, bars, firstSet.has(t.ts));
    return { ...t, ...f };
  });

  // persist per-trade features (recomputed in place — idempotent)
  for (const e of enriched) {
    await sql`
      update trades set
        family = ${e.family},
        hour_bucket = ${e.hourBucket},
        first_of_day = ${e.firstOfDay},
        entry_adverse_pts = ${e.entryAdversePts.toFixed(2)},
        held_min = ${e.heldMin.toFixed(2)},
        mfe_pts = ${e.mfePts === null ? null : e.mfePts.toFixed(2)},
        mae_pts = ${e.maePts === null ? null : e.maePts.toFixed(2)},
        target_reached = ${e.targetReached},
        recovered = ${e.recovered},
        stop_run = ${e.stopRun},
        loss_label = ${e.lossLabel}
      where signal_key = ${e.signalKey}`;
  }

  const stats = aggregateTrades(enriched);
  const windowEnd = new Date();
  await sql`
    insert into trade_analysis (window_start, window_end, trades_n, summary)
    values (${since}, ${windowEnd}, ${enriched.length}, ${JSON.stringify({
      stats,
      windowStart: since.toISOString(),
      windowEnd: windowEnd.toISOString(),
    })})`;

  console.log(renderReport(enriched, stats));
  await sql.end();
}

main().catch((e) => {
  console.error("[tradeAnalysis] failed:", e);
  process.exit(1);
});
