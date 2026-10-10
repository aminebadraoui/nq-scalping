/* ------------------------------------------------------------------ *
 * MANUAL-TRADE AUDIT — label every manual trip by cross-referencing
 * the full signal record.
 *
 * Reads Neon `manual_trades` and `signals` and labels each trip with
 * evidence (lib/manualAudit.ts — the same engine that labels the
 * journal's Manual trades panel live):
 *
 *   BOT          the trip already corrects a bot trade (matched_signal)
 *   BOT-SUSPECT  a signal matches STRICTLY (same day+side, |Δt| ≤ 3 min,
 *                |Δqty| ≤ 2, |Δentry| ≤ 2 pts) but was never paired —
 *                likely a bot trade whose card or pairing failed
 *   AMBIGUOUS    a signal sits within 15 min but outside strict
 *                tolerances (or several match strictly)
 *   MANUAL       no same-side signal within 15 min
 *
 * Also reports the reverse cross-reference: signals with no trades row
 * and no manual trip nearby (orphan cards) and fills the summary with
 * per-label counts.
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs ./scripts/manualTradeAudit.ts
 *   node --import ../scripts/ts-loader.mjs ./scripts/manualTradeAudit.ts --csv /tmp/manual-audit.csv
 *
 * Env (falls back to web/.env.local): DATABASE_URL. Read-only.
 * ------------------------------------------------------------------ */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import {
  auditManualTrips,
  auditSummary,
  type ManualTrip,
  type SignalRef,
} from "../lib/manualAudit";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      if (!process.env[s.slice(0, i).trim()]) process.env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  } catch {
    /* env must be set by the caller */
  }
}
loadEnvLocal();

const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) {
  console.error("manualTradeAudit: need DATABASE_URL");
  process.exit(1);
}
const sql = postgres(DB_URL, { ssl: "require", max: 2, onnotice: () => {} });

const CSV = (() => {
  const i = process.argv.indexOf("--csv");
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : "";
})();

const fmtUsd = (n: number): string => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;
const TAG: Record<string, string> = { bot: "BOT      ", "bot-suspect": "SUSPECT  ", ambiguous: "AMBIGUOUS", manual: "MANUAL   " };

async function main() {
  const trips = (await sql`
    select key, day, direction, qty, entry_price, exit_price,
           coalesce(pnl_net_usd, pnl_usd)::numeric(12,2) as net,
           entry_at, matched_signal
    from manual_trades
    order by entry_at asc`) as Array<Record<string, unknown>>;

  const sigs = (await sql`
    select key, ts, day, side, size, entry from signals
    order by ts asc`) as Array<Record<string, unknown>>;

  const signalList: SignalRef[] = sigs.map((s) => ({
    key: String(s.key),
    day: String(s.day),
    ts: Number(s.ts),
    side: String(s.side) === "long" ? "long" : "short",
    contracts: Number(String(s.size ?? "").match(/^(\d+)\s*MNQ/)?.[1] ?? 0),
    entry: Number(s.entry) || null,
  }));

  const tripsIn: ManualTrip[] = trips.map((t) => ({
    key: String(t.key),
    day: String(t.day),
    direction: String(t.direction) === "long" ? "long" : "short",
    qty: Number(t.qty ?? 0),
    entryPrice: Number(t.entry_price ?? 0),
    exitPrice: Number(t.exit_price ?? 0),
    entryAtMs: Date.parse(String(t.entry_at)),
    matchedSignal: t.matched_signal ? String(t.matched_signal) : null,
  }));

  const labeled = auditManualTrips(tripsIn, signalList);
  const summary = auditSummary(labeled);

  console.log("=== MANUAL-TRADE AUDIT — every manual_trades trip × every signal ===\n");
  console.log(
    `summary: bot ${summary.bot} · suspect ${summary["bot-suspect"]} · ambiguous ${summary.ambiguous} · manual ${summary.manual} · total ${labeled.length}`,
  );
  console.log("(suspect = a bot trade that likely lost its card — cross-reference before trusting the manual bucket)\n");

  const money = (l: string): number =>
    labeled
      .filter((t) => t.evidence.label === l)
      .reduce((s, t) => s + Number((trips.find((x) => String(x.key) === t.key)?.net as number | string) ?? 0), 0);

  console.log("label      n    net");
  for (const l of ["bot", "bot-suspect", "ambiguous", "manual"] as const) {
    console.log(`${TAG[l]} ${String(summary[l]).padStart(4)}  ${fmtUsd(money(l))}`);
  }

  console.log("\nday        time  dir  qty   entry→exit        net       label      evidence");
  for (const t of labeled) {
    const e = t.evidence;
    const ev = [
      e.reason,
      e.nearestSignal ? `sig ${e.nearestSignal}` : "",
      e.dtMin !== null ? `Δt${e.dtMin}m` : "",
      e.dPx !== null ? `Δpx${e.dPx >= 0 ? "+" : ""}${e.dPx}` : "",
      e.dQty !== null ? `Δq${e.dQty}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const net = Number((trips.find((x) => String(x.key) === t.key)?.net as number | string) ?? 0);
    const time = new Date(t.entryAtMs).toISOString().slice(11, 16);
    console.log(
      `${t.day}  ${time}Z  ${t.direction === "long" ? "L" : "S"}   ${String(t.qty).padStart(3)}  ${t.entryPrice.toFixed(2)}→${t.exitPrice.toFixed(2)}  ${fmtUsd(net).padStart(8)}  ${TAG[e.label]}  ${ev}`,
    );
  }

  /* ---- reverse cross-reference: orphan signals (no fill anywhere) ---- */
  const tradeKeys = (await sql`select distinct signal_key from trades`) as Array<{ signal_key: string }>;
  const paired = new Set(tradeKeys.map((r) => String(r.signal_key)));
  const orphans = signalList.filter((s) => !paired.has(s.key));
  console.log(`\n=== reverse cross-reference ===`);
  console.log(`signals recorded ${signalList.length} · paired to a trade ${paired.size} · orphan cards (no trades row) ${orphans.length}`);
  if (orphans.length) {
    console.log("orphan cards (vetoed, unexecuted, or pairing failures — check these against the suspect list):");
    for (const o of orphans.slice(0, 30)) {
      console.log(`  ${o.day} ${new Date(o.ts).toISOString().slice(11, 16)}Z ${o.side.padEnd(5)} ${o.key}`);
    }
    if (orphans.length > 30) console.log(`  … +${orphans.length - 30} more`);
  }

  if (CSV) {
    const head = "key,day,time_utc,direction,qty,entry_price,exit_price,net,label,reason,nearest_signal,dt_min,dpx,dqty";
    const lines = [head];
    for (const t of labeled) {
      const e = t.evidence;
      lines.push(
        [
          t.key,
          t.day,
          new Date(t.entryAtMs).toISOString().slice(11, 16),
          t.direction,
          t.qty,
          t.entryPrice,
          t.exitPrice,
          Number((trips.find((x) => String(x.key) === t.key)?.net as number | string) ?? 0),
          e.label,
          `"${e.reason.replace(/"/g, '""')}"`,
          e.nearestSignal ?? "",
          e.dtMin ?? "",
          e.dPx ?? "",
          e.dQty ?? "",
        ].join(","),
      );
    }
    writeFileSync(CSV, lines.join("\n") + "\n");
    console.log(`\ncsv → ${CSV}`);
  }

  console.log(
    "\ntolerances: strict |Δt| ≤ 3 min · |Δqty| ≤ 2 · |Δentry| ≤ 2 pts (lib/manualAudit.ts, shared with the journal panel).",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
