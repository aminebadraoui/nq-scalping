/* ------------------------------------------------------------------ *
 * Import Tradovate round-trip fills (the broker-side ground truth).
 *
 * Usage (from web/):
 *   node --import ../scripts/ts-loader.mjs ./scripts/importTradovateTrades.ts <path-to-csv>
 *
 * What it does:
 *   1. parses the round-trip CSV (Tradovate UI → Fills export),
 *   2. matches trips to bot signals/trades (same side, qty ±2, entry
 *      within ±3 min): matched trips whose P&L differs from the journal
 *      by > $1 UPDATE the trades row (exit, gross, result — the FLAT
 *      rows CrossTrade never captured),
 *   3. stores EVERY imported trip in `manual_trades` (matched_signal
 *      null = manual bucket) — idempotent upsert by fill-id pair.
 *
 * P&L values are gross (Tradovate round trips carry no commission);
 * the trades row keeps its own commissions, so net = gross − commissions.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { parseTradovateCsv, matchRoundTrips, type RoundTrip } from "../lib/tradovateImport";

const file = process.argv[2];
if (!file) {
  console.error("usage: importTradovateTrades.ts <tradovate-export.csv>");
  process.exit(1);
}

const envFile = readFileSync(".env.local", "utf8");
for (const line of envFile.split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  if (!process.env[s.slice(0, i).trim()]) process.env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
}
const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) {
  console.error("importTradovateTrades: need DATABASE_URL");
  process.exit(1);
}
// the account the exported fills belong to — stamped on every imported row
const CT_ACCOUNT = (process.env.CROSSTRADE_ACCOUNT ?? "").trim();

const DDL = `
create table if not exists manual_trades (
  id bigint generated always as identity primary key,
  key text unique not null,                -- buyFillId|sellFillId
  day text not null,
  symbol text not null,
  direction text not null,
  qty int not null,
  entry_price numeric(10,2) not null,
  exit_price numeric(10,2) not null,
  pnl_usd numeric(12,2) not null,          -- gross (Tradovate round-trip pnl)
  entry_at timestamptz not null,
  exit_at timestamptz not null,
  matched_signal text,                     -- signal_key when it corrected a bot trade
  imported_at timestamptz not null default now()
);
alter table manual_trades add column if not exists account text not null default '';
alter table manual_trades add column if not exists account_source text not null default '';
create index if not exists manual_trades_day_idx on manual_trades (day);
`;

type TradeRow = {
  signal_key: string;
  ts: number;
  side: string;
  contracts: number;
  gross_usd: number;
  commissions: number;
  fill_entry_at: string | null;
};

async function main() {
  const text = readFileSync(file, "utf8");
  const trips = parseTradovateCsv(text);
  if (!trips.length) {
    console.error("no round trips parsed — is this the Tradovate fills export?");
    process.exit(1);
  }
  console.log(`parsed ${trips.length} round trips`);

  const sql = postgres(DB_URL, { max: 1 });
  await sql.unsafe(DDL);

  // load bot trades for the trip window (signal ts ± a day of margin)
  const minTs = Math.min(...trips.map((t) => t.entryAt));
  const maxTs = Math.max(...trips.map((t) => t.exitAt));
  const rows = (await sql`
    select signal_key, ts, side, contracts, gross_usd, commissions, fill_entry_at
    from trades
    where ts >= ${minTs - 86_400_000} and ts <= ${maxTs + 86_400_000}
      and status = 'matched'
      and side in ('long','short')
  `) as TradeRow[];

  const { matched, manual } = matchRoundTrips(trips, rows);

  let updated = 0;
  for (const m of matched) {
    if (!m.corrects) continue;
    const t = m.trip;
    const gross = t.pnlUsd;
    const result = gross > 0.5 ? "win" : gross < -0.5 ? "loss" : "flat";
    const commissions = rows.find((r) => r.signal_key === m.signalKey)?.commissions ?? 0;
    await sql`
      update trades set
        exit_avg = ${t.exitPrice},
        gross_pts = ${(t.pnlUsd / 2 / t.qty).toFixed(2)},
        gross_usd = ${gross.toFixed(2)},
        net_usd = ${(gross - commissions).toFixed(2)},
        result = ${result},
        matched_at = now()
      where signal_key = ${m.signalKey}
        and abs(gross_usd - ${gross.toFixed(2)}) > 0.5`;
    updated++;
    console.log(`  corrected ${m.signalKey}: ${t.direction.toUpperCase()} ${t.qty} ${t.entryPrice} → ${t.exitPrice} = ${gross >= 0 ? "+" : "−"}$${Math.abs(gross).toFixed(2)} (was different)`);
  }

  // persist every trip (manual + matched, for provenance)
  let inserted = 0;
  const byKey = new Map(matched.map((m) => [m.trip.key, m.signalKey]));
  for (const t of trips) {
    const sig = byKey.get(t.key) ?? null;
    await sql`
      insert into manual_trades
        (key, day, symbol, direction, qty, entry_price, exit_price, pnl_usd, entry_at, exit_at, matched_signal, account, account_source)
      values
        (${t.key}, ${t.day}, ${t.symbol}, ${t.direction}, ${t.qty}, ${t.entryPrice}, ${t.exitPrice}, ${t.pnlUsd.toFixed(2)},
         ${new Date(t.entryAt)}, ${new Date(t.exitAt)}, ${sig}, ${CT_ACCOUNT || ""}, ${CT_ACCOUNT ? "fire-time" : ""})
      on conflict (key) do update set
        day = excluded.day, pnl_usd = excluded.pnl_usd, matched_signal = excluded.matched_signal,
        account = excluded.account, account_source = excluded.account_source`;
    inserted++;
  }

  const manualTotals = (await sql`
    select count(*) n, sum(pnl_usd)::numeric(12,2) total, count(distinct day) days
    from manual_trades where matched_signal is null`) as Array<Record<string, unknown>>;
  const m = manualTotals[0];

  console.log(`\n=== import summary ===`);
  console.log(`matched ${matched.length} bot trades (${updated} corrected against the journal)`);
  console.log(`manual bucket: ${m.n} round trips · ${m.days} day(s) · gross ${m.total}`);
  await sql.end();
}

main().catch((e) => {
  console.error("[importTradovateTrades] failed:", e);
  process.exit(1);
});
