/* ------------------------------------------------------------------ *
 * restoreJournal — rebuild the operational journal tables on a fresh
 * Neon project from the DB-less sources (2026-10-08, nq-store2).
 *
 * The paused nq-store project could not be dumped (quota-paused projects
 * refuse connections), so the rebuild pulls everything that exists
 * OUTSIDE Neon:
 *
 *   · signals  — the live dashboard's daybook JSONL (volume ∪ R2),
 *                served by GET /api/daybook?day=… (no auth)
 *   · exec_log — the same daybook `exec` records
 *   · trades   — the dayend consolidation summaries (the fill-level
 *                reconstruction the nightly consolidation already did),
 *                inserted as source='daybook' rows so days whose signal
 *                records are gone still appear in the DB-mode journal
 *
 * The CrossTrade side (the actual fills → trades pairing) is rebuilt by
 * scripts/reconcileTrades.ts afterwards, which reads the restored
 * signals and the durable fill history (both accounts).
 *
 * Run from web/:
 *   DATABASE_URL=<new uri> node --import scripts/ts-loader.mjs ./scripts/restoreJournal.ts
 *
 * Idempotent: every insert is keyed on a content hash, `on conflict do
 * nothing` — safe to re-run after more days surface on the VPS volume.
 * Env: DASHBOARD_URL (default the production dashboard).
 * ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const DASHBOARD = process.env.DASHBOARD_URL ?? "https://nq-dashboard.31.97.138.30.sslip.io";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("restoreJournal: set DATABASE_URL (the new project URI)");
  process.exit(1);
}

const h = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

/* keep in sync with lib/signalHistory.ts TABLE_SQL + lib/execLog.ts TABLE_SQL
 * + scripts/reconcileTrades.ts trades DDL — the producers re-assert these on
 * their next run, so an exact copy here only makes the restore self-contained. */
const DDL = `
create table if not exists signals (
  id      bigint generated always as identity primary key,
  key     text unique not null,
  ts      bigint not null,
  day     text not null,
  time_et text not null default '',
  symbol  text not null,
  side    text not null,
  price   numeric(10,2) not null default 0,
  entry   text not null default '',
  stop    text not null default '',
  target  text not null default '',
  size    text not null default '',
  verdict text not null default '',
  headline text not null default '',
  source  text not null default 'live',
  test    boolean not null default false,
  sent    boolean not null default false,
  reason  text not null default '',
  features jsonb,
  outcome      text not null default '',
  exit_price   numeric(10,2),
  exit_time    text not null default '',
  exit_reason  text not null default '',
  mfe_pts      numeric(10,2),
  mae_pts      numeric(10,2),
  scored_at    timestamptz
);
create index if not exists signals_ts_idx on signals (ts desc);
create index if not exists signals_outcome_idx on signals (outcome, day);

create table if not exists exec_log (
  id bigint generated always as identity primary key,
  ts bigint not null,
  key text not null,
  label text not null,
  attempt text not null,
  outcome text not null,
  reason text not null default '',
  meta jsonb
);
create unique index if not exists exec_log_key_idx on exec_log (key);

create table if not exists trades (
  id bigint generated always as identity primary key,
  signal_key text unique not null,
  day text not null,
  time_et text not null default '',
  ts bigint not null,
  side text not null,
  contracts int not null default 0,
  verdict text not null default '',
  headline text not null default '',
  sig_entry numeric(10,2),
  sig_stop numeric(10,2),
  sig_target numeric(10,2),
  status text not null default 'unexecuted',
  fill_entry numeric(10,2),
  fill_entry_at timestamptz,
  exit_avg numeric(10,2),
  exit_fills jsonb,
  gross_pts numeric(10,2) not null default 0,
  gross_usd numeric(10,2) not null default 0,
  commissions numeric(10,2) not null default 0,
  net_usd numeric(10,2) not null default 0,
  result text not null default '',
  features jsonb,
  source text not null default 'reconcile',
  matched_at timestamptz not null default now()
);
create index if not exists trades_ts_idx on trades (ts desc);

-- the manual bucket (importTradovateTrades/importMffTrades DDL, empty on a
-- rebuild — /api/trades references the table even when it has no rows)
create table if not exists manual_trades (
  id bigint generated always as identity primary key,
  key text unique not null,
  day text not null,
  symbol text not null,
  direction text not null,
  qty int not null,
  entry_price numeric(10,2) not null,
  exit_price numeric(10,2) not null,
  pnl_usd numeric(12,2) not null,
  pnl_net_usd numeric(12,2),
  fees_usd numeric(12,2),
  entry_at timestamptz not null,
  exit_at timestamptz not null,
  matched_signal text,
  imported_at timestamptz not null default now()
);
create index if not exists manual_trades_day_idx on manual_trades (day);
`;

type DaybookRecord = Record<string, unknown> & { t: string };

async function fetchDaybook(day: string): Promise<DaybookRecord[]> {
  const res = await fetch(`${DASHBOARD}/api/daybook?day=${day}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`daybook ${day}: HTTP ${res.status}`);
  const j = (await res.json()) as { records?: DaybookRecord[] };
  return j.records ?? [];
}

async function fetchIndex(): Promise<string[]> {
  const res = await fetch(`${DASHBOARD}/api/daybook`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`daybook index: HTTP ${res.status}`);
  const j = (await res.json()) as { days?: Array<{ day: string }> };
  return (j.days ?? []).map((d) => d.day).sort();
}

/** epoch ms for a feed-clock "HH:mm" on a day — matches the producers' ts */
function dayTs(day: string, timeET: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(timeET);
  const hhmm = m ? timeET : "12:00";
  return Date.parse(`${day}T${hhmm}:00-05:00`);
}

async function main(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 2 });
  // the full market-data schema (candles/footprint/sheets/events/sessions) —
  // empty on a rebuilt project, but the nightly steps expect the tables to
  // exist (scoreSignals etc. reference candles_1m even for file replay)
  const schemaSql = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8");
  await sql.unsafe(schemaSql);
  await sql.unsafe(DDL);
  console.log("[restore] schema ensured (db/schema.sql + operational tables)");

  const days = await fetchIndex();
  console.log(`[restore] daybook days: ${days.join(", ") || "(none)"}`);

  let sigN = 0;
  let execN = 0;
  let tradeN = 0;

  for (const day of days) {
    const recs = await fetchDaybook(day);
    for (const r of recs) {
      if (r.t === "signal" && (r.side === "long" || r.side === "short")) {
        const key = `daybook-${h(`${day}|${r.at}|${r.timeET}|${r.side}|${r.verdict}`)}`;
        await sql`
          insert into signals
            (key, ts, day, time_et, symbol, side, price, entry, stop, target, size, verdict, headline, source, test, sent, reason, features)
          values
            (${key}, ${Number(r.at)}, ${String(r.day ?? day)}, ${String(r.timeET ?? "")}, ${String(r.symbol ?? "NQ")},
             ${String(r.side)}, ${Number(r.price ?? 0)}, ${String(r.entry ?? "")}, ${String(r.stop ?? "")},
             ${String(r.target ?? "")}, ${String(r.size ?? "—")}, ${String(r.verdict ?? "")}, ${String(r.headline ?? "")},
             ${String(r.source ?? "live")}, ${r.test === true}, ${r.sent === true}, ${String(r.reason ?? "")},
             ${r.features ? sql.json(r.features as never) : null})
          on conflict (key) do nothing`;
        sigN++;
      } else if (r.t === "exec") {
        const key = `daybook-exec-${h(`${day}|${r.at}|${r.label}|${r.outcome}`)}`;
        await sql`
          insert into exec_log (ts, key, label, attempt, outcome, reason)
          values (${Number(r.at)}, ${key}, ${String(r.label ?? "")}, ${String(r.attempt ?? "")},
                  ${String(r.outcome ?? "")}, ${String(r.reason ?? "")})
          on conflict (key) do nothing`;
        execN++;
      } else if (r.t === "dayend") {
        const trades = (r.summary as { trades?: Array<Record<string, unknown>> } | undefined)?.trades ?? [];
        for (let i = 0; i < trades.length; i++) {
          const t = trades[i];
          if (t.side !== "long" && t.side !== "short") continue;
          const key = `dayend-${day}-${i}`;
          const timeET = String(t.timeET ?? "");
          const stop = Number(t.stop ?? 0);
          const target = Number(t.target ?? 0);
          await sql`
            insert into trades
              (signal_key, day, time_et, ts, side, contracts, verdict, headline,
               sig_entry, sig_stop, sig_target, status, fill_entry, exit_avg,
               gross_pts, gross_usd, commissions, net_usd, result, source, matched_at)
            values
              (${key}, ${day}, ${timeET}, ${dayTs(day, timeET)}, ${String(t.side)}, ${Number(t.contracts ?? 0)},
               ${String(t.verdict ?? "")}, '', null, ${stop > 0 ? stop : null}, ${target > 0 ? target : null},
               'matched', ${Number(t.entry)}, ${Number(t.exit)},
               ${Number(t.exit ?? 0) - Number(t.entry ?? 0)}, ${Number(t.grossUsd ?? 0)}, ${Number(t.commissions ?? 0)},
               ${Number(t.netUsd ?? 0)}, ${String(t.result ?? "flat")}, 'daybook', now())
            on conflict (signal_key) do nothing`;
          tradeN++;
        }
      }
    }
  }

  await sql.end();
  console.log(`[restore] inserted (best-effort, deduped): ${sigN} signals · ${execN} exec rows · ${tradeN} daybook trades`);
  console.log("[restore] next: reconcileTrades.ts --since 2026-09-28, then tradeAnalysis.ts + scoreSignals.ts");
}

main().catch((e) => {
  console.error("restoreJournal failed:", e);
  process.exit(1);
});
