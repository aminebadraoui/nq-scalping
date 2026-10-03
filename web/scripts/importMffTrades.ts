/* ------------------------------------------------------------------ *
 * Import the MFF (MyFundedFutures) trades list — the DEFINITIVE record.
 *
 * Usage (from web/):
 *   node --import ../scripts/ts-loader.mjs ./scripts/importMffTrades.ts <mff.txt>
 *
 * The MFF list carries NET P&L per round trip (commissions included) and
 * sums exactly to the account's total P&L — this is the journal's
 * foundation import. It supersedes Tradovate/CrossTrade pairing for
 * everything it covers:
 *   · matched bot trades are OVERWRITTEN with MFF net/gross/fees/exit,
 *   · bot trades the MFF list has NO trade for (the fallback pairing
 *     invented them from the long's exit fills) are reset to unexecuted,
 *   · unmatched MFF trades + the manual share of grouped trades land in
 *     manual_trades with net P&L (new pnl_net_usd / fees_usd columns).
 *
 * Idempotent — re-run any time with a fresh export.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { parseMffTrades, matchMff } from "../lib/mffImport";

const file = process.argv[2];
if (!file) {
  console.error("usage: importMffTrades.ts <mff-trades.txt>");
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
  console.error("importMffTrades: need DATABASE_URL");
  process.exit(1);
}

const DDL = `
alter table manual_trades add column if not exists pnl_net_usd numeric(12,2);
alter table manual_trades add column if not exists fees_usd numeric(12,2);
`;

async function main() {
  const mff = parseMffTrades(readFileSync(file, "utf8"));
  if (!mff.length) {
    console.error("no MFF trades parsed — is this the MFF trades list?");
    process.exit(1);
  }
  console.log(`parsed ${mff.length} MFF round trips`);
  const mffNet = Math.round(mff.reduce((s, t) => s + t.netUsd, 0) * 100) / 100;
  console.log(`MFF total net P&L: ${mffNet >= 0 ? "+" : "−"}$${Math.abs(mffNet).toFixed(2)}`);

  const sql = postgres(DB_URL, { max: 1 });
  await sql.unsafe(DDL);

  const minTs = Math.min(...mff.map((t) => t.entryAt));
  const maxTs = Math.max(...mff.map((t) => t.exitAt));

  // the MFF list SUPERSEDES earlier gross-only imports (Tradovate round
  // trips) for its window — purge them so the manual bucket isn't counted
  // twice (net + gross mixed)
  const purged = (await sql`
    delete from manual_trades
    where key not like 'mff|%'
      and entry_at >= ${new Date(minTs - 86_400_000)}
      and entry_at <= ${new Date(maxTs + 86_400_000)}
  `) as unknown as { count: number };
  console.log(`purged ${purged.count} pre-MFF manual rows in the window (superseded)`);

  const rows = (await sql`
    select signal_key, ts, side, contracts, gross_usd, fill_entry_at
    from trades
    where ts >= ${minTs - 86_400_000} and ts <= ${maxTs + 86_400_000}
      and status = 'matched'
      and side in ('long','short')
  `) as Array<{
    signal_key: string;
    ts: number;
    side: string;
    contracts: number;
    gross_usd: number;
    fill_entry_at: string | null;
  }>;

  const { assignments, manual, matchedKeys } = matchMff(mff, rows);

  let updated = 0;
  for (const a of assignments) {
    await sql`
      update trades set
        exit_avg = ${a.exitAvg},
        gross_pts = ${(a.grossUsd / 2 / a.botQty).toFixed(2)},
        gross_usd = ${a.grossUsd.toFixed(2)},
        commissions = ${a.feesUsd.toFixed(2)},
        net_usd = ${a.netUsd.toFixed(2)},
        result = ${a.result},
        matched_at = now()
      where signal_key = ${a.signalKey}`;
    updated++;
  }

  // phantom trades: the fallback pairing gave them entries that were really
  // the LONG trades' exits — the MFF list has no trade for them at all
  let phantom = 0;
  for (const r of rows) {
    if (matchedKeys.has(r.signal_key)) continue;
    await sql`
      update trades set status = 'unexecuted', fill_entry = null, fill_entry_at = null,
        exit_avg = null, exit_fills = null, gross_pts = 0, gross_usd = 0,
        commissions = 0, net_usd = 0, result = '', matched_at = now()
      where signal_key = ${r.signal_key}`;
    phantom++;
    console.log(`  phantom → unexecuted: ${r.signal_key} (${r.side} ${r.contracts})`);
  }

  let manualNet = 0;
  for (const m of manual) {
    await sql`
      insert into manual_trades
        (key, day, symbol, direction, qty, entry_price, exit_price, pnl_usd, pnl_net_usd, fees_usd, entry_at, exit_at, matched_signal)
      values
        (${"mff|" + m.key}, ${m.day}, ${m.symbol}, ${m.direction}, ${m.splitQty},
         ${m.entryPrice}, ${m.exitPrice}, ${(m.splitNet + m.splitFees).toFixed(2)}, ${m.splitNet.toFixed(2)}, ${m.splitFees.toFixed(2)},
         ${new Date(m.entryAt)}, ${new Date(m.exitAt)}, null)
      on conflict (key) do update set
        pnl_usd = excluded.pnl_usd, pnl_net_usd = excluded.pnl_net_usd, fees_usd = excluded.fees_usd,
        qty = excluded.qty, matched_signal = null`;
    manualNet += m.splitNet;
  }
  manualNet = Math.round(manualNet * 100) / 100;

  const botNet = (await sql`
    select sum(net_usd)::numeric(12,2) net from trades
    where ts >= ${minTs - 86_400_000} and ts <= ${maxTs + 86_400_000} and status = 'matched'`) as Array<{ net: string }>;

  console.log(`\n=== foundation import summary ===`);
  console.log(`bot trades overwritten: ${updated} · phantoms reset: ${phantom}`);
  console.log(`manual: ${manual.length} row(s) · net ${manualNet >= 0 ? "+" : "−"}$${Math.abs(manualNet).toFixed(2)}`);
  console.log(`bot net: ${Number(botNet[0].net) >= 0 ? "+" : "−"}$${Math.abs(Number(botNet[0].net)).toFixed(2)}`);
  const sum = Number(botNet[0].net) + manualNet;
  console.log(`BOT + MANUAL = ${sum >= 0 ? "+" : "−"}$${Math.abs(sum).toFixed(2)} · MFF total = ${mffNet >= 0 ? "+" : "−"}$${Math.abs(mffNet).toFixed(2)} (Δ ${(sum - mffNet).toFixed(2)})`);

  await sql.end();
}

main().catch((e) => {
  console.error("[importMffTrades] failed:", e);
  process.exit(1);
});
