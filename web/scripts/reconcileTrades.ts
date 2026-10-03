/* ------------------------------------------------------------------ *
 * ReconcileTrades — join the signal record (Neon `signals`) with the
 * execution record (CrossTrade Tradovate fills) and persist one row per
 * trade signal in Neon `trades`, plus a per-run summary in
 * `reconcile_runs`.
 *
 * Purpose: "did that Telegram card trade, and how did it do?" becomes a
 * one-query job instead of a three-system hunt (DB + CrossTrade API +
 * container logs). Signals that never got a fill land as `unexecuted`;
 * fills no signal explains are counted as manual.
 *
 * Sources:
 *   - Neon `signals`          (recorded by the feed at card time)
 *   - CrossTrade session fills        GET /v1/api/tv/fills
 *   - CrossTrade durable fill history GET /v1/api/tv/fills/history
 *     (survives the ~17:00 ET daily session reset; carries commission +
 *      fees, but is captured periodically so it can lag/be empty)
 *   - CrossTrade account snapshot     (realized P&L for the run row)
 *
 * Run from web/ (manual or nightly.sh after ingest):
 *   node --import scripts/ts-loader.mjs ./scripts/reconcileTrades.ts
 *   node --import scripts/ts-loader.mjs ./scripts/reconcileTrades.ts --since 2026-10-01T16:00:00Z
 *
 * Env (falls back to web/.env.local): DATABASE_URL, CROSSTRADE_KEY,
 * CROSSTRADE_ACCOUNT. CT_COMMISSION_PER_SIDE overrides the per-side
 * commission estimate used when CrossTrade's fill history has no fee
 * rows yet (default 0.95 — the empirically implied all-in rate).
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { sessionDayOf } from "../lib/times";
import {
  entryCandidates,
  assignEntries,
  childExitFills,
  fallbackExitFills,
  type OrderRow,
  type FillRow,
} from "../lib/reconcile";

/* ---- env ------------------------------------------------------------ */
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
    /* no .env.local — env must be set by the caller */
  }
}
loadEnvLocal();

const DB_URL = process.env.DATABASE_URL ?? "";
const CT_KEY = process.env.CROSSTRADE_KEY ?? "";
const CT_ACCOUNT = process.env.CROSSTRADE_ACCOUNT ?? "";
const COMMISSION_PER_SIDE = Number(process.env.CT_COMMISSION_PER_SIDE ?? "0.95");

if (!DB_URL || !CT_KEY || !CT_ACCOUNT) {
  console.error("reconcileTrades: need DATABASE_URL, CROSSTRADE_KEY, CROSSTRADE_ACCOUNT");
  process.exit(1);
}

/* ---- window --------------------------------------------------------- */
const HOUR = 3_600_000;
const sinceArg = process.argv.find((a) => a === "--since") ?? null;
const sinceIdx = sinceArg ? process.argv.indexOf(sinceArg) : -1;
const sinceRaw = sinceArg && sinceIdx >= 0 ? process.argv[sinceIdx + 1] : "";
let windowStartMs = Date.now() - 26 * HOUR; // default: last 26h (covers a full session + overnight)
if (sinceRaw) {
  const t = Date.parse(sinceRaw);
  if (!Number.isFinite(t)) {
    console.error(`reconcileTrades: bad --since value "${sinceRaw}"`);
    process.exit(1);
  }
  windowStartMs = t;
}
const windowEndMs = Date.now();
const windowStart = new Date(windowStartMs);
const windowEnd = new Date(windowEndMs);
console.log(`[reconcile] window ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);

/* ---- CrossTrade fills ---------------------------------------------- */
type RawFill = {
  ts: number; // epoch ms
  action: "Buy" | "Sell";
  qty: number;
  price: number;
  instrument: string;
  orderId: string;
  commission: number;
  fees: number;
};

const ctGet = async (url: string) => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CT_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CrossTrade ${res.status} for ${url}`);
  return res.json() as Promise<unknown>;
};

async function fetchFills(): Promise<RawFill[]> {
  const map: Record<string, RawFill> = {};

  // durable history first (has commission + fees) — paginated
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        from: windowStart.toISOString(),
        to: windowEnd.toISOString(),
        limit: "1000",
        account: CT_ACCOUNT,
      });
      if (cursor) q.set("cursor", cursor);
      const d = (await ctGet(
        `https://app.crosstrade.io/v1/api/tv/fills/history?${q.toString()}`,
      )) as { success?: boolean; data?: Array<Record<string, unknown>>; nextCursor?: string | null };
      for (const f of d.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < windowStartMs || ts >= windowEndMs) continue;
        const key = `${f.fillId ?? f.executionId ?? ""}|${f.orderId ?? ""}|${ts}|${f.qty}|${f.price}|${f.action}`;
        map[key] = {
          ts,
          action: String(f.action) === "Buy" ? "Buy" : "Sell",
          qty: Number(f.qty ?? 0),
          price: Number(f.price ?? 0),
          instrument: String(f.instrument ?? ""),
          orderId: String(f.orderId ?? ""),
          commission: Number(f.commission ?? 0),
          fees: Number(f.fees ?? 0),
        };
      }
      cursor = d.nextCursor ?? undefined;
      if (!cursor) break;
    }
  } catch (e) {
    console.warn(`[reconcile] durable fill history unavailable: ${String(e)}`);
  }

  // session fills (live, reset ~17:00 ET daily) — fill gaps the history misses
  try {
    const d = (await ctGet("https://app.crosstrade.io/v1/api/tv/fills")) as {
      success?: boolean;
      data?: Array<{ data?: Array<Record<string, unknown>> }>;
    };
    for (const env of d.data ?? []) {
      for (const f of env.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < windowStartMs || ts >= windowEndMs) continue;
        const key = `${f.id ?? ""}|${f.orderId ?? ""}|${ts}|${f.qty}|${f.price}|${f.action}`;
        if (map[key]) continue; // history row (with fees) wins
        map[key] = {
          ts,
          action: String(f.action) === "Buy" ? "Buy" : "Sell",
          qty: Number(f.qty ?? 0),
          price: Number(f.price ?? 0),
          instrument: String(f.instrument ?? ""),
          orderId: String(f.orderId ?? ""),
          commission: 0,
          fees: 0,
        };
      }
    }
  } catch (e) {
    console.warn(`[reconcile] session fills unavailable: ${String(e)}`);
  }

  return Object.values(map).sort((a, b) => a.ts - b.ts);
}

/* ---- signals -------------------------------------------------------- */
type SignalRow = {
  key: string;
  ts: number;
  day: string;
  timeET: string;
  side: "long" | "short";
  contracts: number;
  verdict: string;
  headline: string;
  entry: number;
  stop: number;
  target: number;
  features: Record<string, unknown> | null;
};

const sql = postgres(DB_URL, { max: 1 });

const TABLE_SQL = `
alter table signals add column if not exists features jsonb;
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
  matched_at timestamptz not null default now()
);
alter table trades add column if not exists features jsonb;
create index if not exists trades_ts_idx on trades (ts desc);
create table if not exists reconcile_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  window_start timestamptz not null,
  window_end timestamptz not null,
  fills_total int not null default 0,
  signals_total int not null default 0,
  matched int not null default 0,
  unexecuted int not null default 0,
  manual_fills int not null default 0,
  manual_gross_usd numeric(12,2) not null default 0,
  signals_gross_usd numeric(12,2) not null default 0,
  account_net numeric(12,2),
  account_realized numeric(12,2),
  notes text not null default ''
);
`;

async function fetchOrders(): Promise<OrderRow[]> {
  try {
    const d = (await ctGet("https://app.crosstrade.io/v1/api/tv/orders?activeOnly=false")) as {
      success?: boolean;
      data?: Array<{ data?: Array<Record<string, unknown>> }>;
    };
    const out: OrderRow[] = [];
    for (const env of d.data ?? []) {
      for (const o of env.data ?? []) {
        const ts = Date.parse(String(o.timestamp ?? ""));
        if (!Number.isFinite(ts)) continue;
        out.push({
          id: String(o.id),
          ts,
          action: String(o.action) === "Buy" ? "Buy" : "Sell",
          parentId: o.parentId !== null && o.parentId !== undefined ? String(o.parentId) : null,
        });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  } catch (e) {
    console.warn(`[reconcile] orders unavailable: ${String(e)}`);
    return [];
  }
}

async function fetchSignals(): Promise<SignalRow[]> {
  const rows = await sql`
    select key, ts, day, time_et, side, entry, stop, target, size, verdict, headline, features
    from signals
    where test = false
      and side in ('long','short')
      and ts >= ${windowStartMs} and ts <= ${windowEndMs}
      and entry ~ '^[0-9]+(\\.[0-9]+)?$'
    order by ts asc`;
  const out: SignalRow[] = [];
  for (const r of rows) {
    const m = String(r.size).match(/^(\d+)\s*MNQ/);
    const contracts = m ? Number(m[1]) : 0;
    if (contracts <= 0) continue;
    let features: Record<string, unknown> | null = null;
    if (r.features !== null && r.features !== undefined) {
      try {
        features = typeof r.features === "string" ? JSON.parse(r.features) : (r.features as Record<string, unknown>);
      } catch {
        features = null;
      }
    }
    out.push({
      key: String(r.key),
      ts: Number(r.ts),
      day: String(r.day),
      timeET: String(r.time_et),
      side: String(r.side) === "long" ? "long" : "short",
      contracts,
      verdict: String(r.verdict),
      headline: String(r.headline),
      entry: Number(r.entry),
      stop: Number(r.stop),
      target: Number(r.target),
      features,
    });
  }
  return out;
}

/* ---- pairing -------------------------------------------------------- */
const MNQ = "MNQZ6";
const ENTRY_BEFORE_MS = 30_000;
const ENTRY_AFTER_MS = 15 * 60_000; // generous: the Playwright era filled up to ~5 min late

type TradeRow = {
  sig: SignalRow;
  status: "matched" | "unexecuted";
  fillEntry?: number;
  fillEntryAt?: number;
  exitAvg?: number;
  exitFills?: Array<{ ts: number; action: string; qty: number; price: number }>;
  grossPts: number;
  grossUsd: number;
  commissions: number;
  result: "win" | "loss" | "flat" | "";
  sides: number;
};

function pair(
  fills: RawFill[],
  signals: SignalRow[],
  orders: OrderRow[],
): { trades: TradeRow[]; manual: RawFill[]; usedOrderIds: Set<string> } {
  // order-level matching: entries are top-level orders, exits are their
  // CHILD orders' fills — a fill can never be stolen across trades.
  const fillRows: FillRow[] = fills.map((f) => ({
    ts: f.ts,
    action: f.action,
    qty: f.qty,
    price: f.price,
    orderId: f.orderId,
    instrument: f.instrument,
    commission: f.commission,
    fees: f.fees,
  }));
  const candidates = entryCandidates(orders, fillRows);
  const assignment = assignEntries(signals, candidates, ENTRY_BEFORE_MS, ENTRY_AFTER_MS);
  const usedIds = new Set<string>([...assignment.values()].flat().map((c) => c.order.id));
  const trades: TradeRow[] = [];

  const nextEntryTsAfter = (t: number): number | null => {
    let best: number | null = null;
    for (const c of candidates) {
      if (usedIds.has(c.order.id) || c.order.ts <= t) continue;
      if (best === null || c.order.ts < best) best = c.order.ts;
    }
    return best;
  };

  for (const sig of signals) {
    const picked = assignment.get(sig.key) ?? [];
    if (!picked.length) {
      trades.push({ sig, status: "unexecuted", grossPts: 0, grossUsd: 0, commissions: 0, result: "", sides: 0 });
      continue;
    }

    const entryFills = picked.flatMap((c) => c.fills);
    const entryQty = entryFills.reduce((s, f) => s + f.qty, 0);
    const entryCost = entryFills.reduce((s, f) => s + f.qty * f.price, 0);
    const entryAt = Math.max(...entryFills.map((f) => f.ts));
    const fillEntry = entryCost / entryQty;

    let exitFills = childExitFills(picked, orders, fillRows);
    if (exitFills.length === 0) {
      // manual cover / missing children: bounded chronological fallback
      exitFills = fallbackExitFills(
        picked,
        fillRows.filter((f) => !usedIds.has(f.orderId)),
        nextEntryTsAfter(entryAt),
        sig.contracts,
        "MNQ",
      );
    }
    const exitQty = exitFills.reduce((s, f) => s + f.qty, 0);
    const exitCost = exitFills.reduce((s, f) => s + f.qty * f.price, 0);
    const exitAvg = exitQty > 0 ? exitCost / exitQty : 0;

    const dir = sig.side === "long" ? 1 : -1;
    const grossPts = exitQty > 0 ? (exitAvg - fillEntry) * dir * Math.min(entryQty, sig.contracts) : 0;
    const grossUsd = grossPts * 2; // MNQ $2/pt
    const allFills = [...entryFills, ...exitFills];
    const realFees = allFills.reduce((s, f) => s + f.commission + f.fees, 0);
    const totalContracts = allFills.reduce((s, f) => s + f.qty, 0);
    const commissions = realFees > 0 ? realFees : totalContracts * COMMISSION_PER_SIDE;
    const result: TradeRow["result"] = grossUsd > 0.5 ? "win" : grossUsd < -0.5 ? "loss" : "flat";

    trades.push({
      sig,
      status: "matched",
      fillEntry,
      fillEntryAt: entryAt,
      exitAvg: exitQty > 0 ? exitAvg : undefined,
      exitFills: exitFills.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price })),
      grossPts,
      grossUsd,
      commissions,
      result,
      sides: allFills.length,
    });
  }

  // manual = fills whose order is neither a matched entry nor its child
  const childIds = new Set(
    orders.filter((o) => o.parentId !== null && usedIds.has(o.parentId)).map((o) => o.id),
  );
  const manual = fills.filter((f) => !usedIds.has(f.orderId) && !childIds.has(f.orderId));
  return { trades, manual, usedOrderIds: usedIds };
}

/** order-level net P&L for the manual bucket: pair each unassigned
 *  top-level order with its child exits (fallback: bounded scan), so
 *  leaked legs can never feed a naive FIFO garbage. */
function manualNetUsd(orders: OrderRow[], fills: RawFill[], excludedOrderIds: Set<string>): number {
  const fillRows: FillRow[] = fills.map((f) => ({
    ts: f.ts,
    action: f.action,
    qty: f.qty,
    price: f.price,
    orderId: f.orderId,
    instrument: f.instrument,
    commission: f.commission,
    fees: f.fees,
  }));
  const candidates = entryCandidates(orders, fillRows).filter((c) => !excludedOrderIds.has(c.order.id));
  let usd = 0;
  for (const c of candidates) {
    const entryQty = c.fills.reduce((s, f) => s + f.qty, 0);
    if (entryQty <= 0) continue;
    const entryAvg = c.fills.reduce((s, f) => s + f.qty * f.price, 0) / entryQty;
    const dir = c.order.action === "Buy" ? 1 : -1;
    const pv = c.fills[0].instrument === "MESZ6" ? 5 : 2;
    let exits = childExitFills([c], orders, fillRows);
    if (!exits.length) {
      exits = fallbackExitFills([c], fillRows, null, entryQty, c.fills[0].instrument.startsWith("MNQ") ? "MNQ" : "MES");
    }
    const exitQty = exits.reduce((s, f) => s + f.qty, 0);
    if (exitQty <= 0) continue;
    const exitAvg = exits.reduce((s, f) => s + f.qty * f.price, 0) / exitQty;
    usd += (exitAvg - entryAvg) * dir * Math.min(entryQty, exitQty) * pv;
  }
  return usd;
}

/* ---- main ----------------------------------------------------------- */
async function main() {
  await sql.unsafe(TABLE_SQL);

  const [fills, signals, orders] = await Promise.all([fetchFills(), fetchSignals(), fetchOrders()]);
  console.log(`[reconcile] fills=${fills.length} signals=${signals.length}`);
  if (!fills.length) {
    console.warn(
      "[reconcile] WARNING: no fills in window — CrossTrade journal capture may be disabled (Tradovate journal import) or the session reset already happened. Re-run after the durable history catches up.",
    );
  }

  const { trades, manual, usedOrderIds: usedIds } = pair(fills, signals, orders);
  const matched = trades.filter((t) => t.status === "matched");
  const unexecuted = trades.filter((t) => t.status === "unexecuted");
  const excluded = new Set<string>([
    ...usedIds,
    ...orders.filter((o) => o.parentId !== null && usedIds.has(o.parentId)).map((o) => o.id),
  ]);
  const manualGross = manualNetUsd(orders, fills, excluded);

  // snapshot for the run row (best effort)
  let accountNet: number | null = null;
  let accountRealized: number | null = null;
  try {
    const d = (await ctGet("https://app.crosstrade.io/v1/api/tv/accounts/snapshot")) as {
      accounts?: Array<{ name: string; netLiq?: number; realizedPnl?: number }>;
    };
    const acct = (d.accounts ?? []).find((a) => a.name.toUpperCase() === CT_ACCOUNT.toUpperCase());
    if (acct) {
      accountNet = acct.netLiq ?? null;
      accountRealized = acct.realizedPnl ?? null;
    }
  } catch {
    /* non-fatal */
  }

  // persist trade rows (upsert on signal_key so re-runs backfill, never duplicate)
  for (const t of trades) {
    const s = t.sig;
    await sql`
      insert into trades
        (signal_key, day, time_et, ts, side, contracts, verdict, headline,
         sig_entry, sig_stop, sig_target, status, fill_entry, fill_entry_at,
         exit_avg, exit_fills, gross_pts, gross_usd, commissions, net_usd, result, features, matched_at)
      values
        (${s.key}, ${sessionDayOf(s.ts)}, ${s.timeET}, ${s.ts}, ${s.side}, ${s.contracts}, ${s.verdict}, ${s.headline},
         ${s.entry}, ${s.stop}, ${s.target}, ${t.status},
         ${t.fillEntry ?? null}, ${t.fillEntryAt ? new Date(t.fillEntryAt) : null},
         ${t.exitAvg ?? null}, ${t.exitFills ? JSON.stringify(t.exitFills) : null},
         ${t.grossPts.toFixed(2)}, ${t.grossUsd.toFixed(2)}, ${t.commissions.toFixed(2)},
         ${(t.grossUsd - t.commissions).toFixed(2)}, ${t.result}, ${s.features ? JSON.stringify(s.features) : null}, now())
      on conflict (signal_key) do update set
        day = excluded.day,
        status = excluded.status,
        fill_entry = excluded.fill_entry,
        fill_entry_at = excluded.fill_entry_at,
        exit_avg = excluded.exit_avg,
        exit_fills = excluded.exit_fills,
        gross_pts = excluded.gross_pts,
        gross_usd = excluded.gross_usd,
        commissions = excluded.commissions,
        net_usd = excluded.net_usd,
        result = excluded.result,
        features = excluded.features,
        matched_at = now()`;
  }

  const signalsGross = matched.reduce((s, t) => s + t.grossUsd, 0);
  const notes = [
    accountRealized != null ? `account realizedPnl ${accountRealized}` : null,
    !fills.length ? "NO FILLS IN WINDOW — check CrossTrade journal import" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  await sql`
    insert into reconcile_runs
      (window_start, window_end, fills_total, signals_total, matched, unexecuted,
       manual_fills, manual_gross_usd, signals_gross_usd, account_net, account_realized, notes)
    values
      (${windowStart}, ${windowEnd}, ${fills.length}, ${signals.length}, ${matched.length}, ${unexecuted.length},
       ${manual.length}, ${manualGross.toFixed(2)}, ${signalsGross.toFixed(2)},
       ${accountNet ?? null}, ${accountRealized ?? null}, ${notes})`;

  // ---- console summary ----
  console.log("\n=== reconciliation summary ===");
  const fmtT = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  for (const t of trades) {
    const s = t.sig;
    if (t.status === "unexecuted") {
      console.log(`UNEXECUTED  ${s.timeET} ${s.side.toUpperCase().padEnd(5)} ${s.verdict} (${s.contracts} MNQ) — no fill found`);
      continue;
    }
    const entryStr = t.fillEntry?.toFixed(2) ?? "—";
    const exitStr = t.exitAvg?.toFixed(2) ?? "open";
    const at = t.fillEntryAt ? ` @ ${fmtT(t.fillEntryAt)}Z` : "";
    console.log(
      `${t.result?.toUpperCase().padEnd(4)} ${s.timeET} ${s.side.toUpperCase().padEnd(5)} ${s.contracts} MNQ ` +
        `entry ${entryStr}${at} exit ${exitStr} · ${t.grossPts >= 0 ? "+" : ""}${t.grossPts.toFixed(1)} pts = $${t.grossUsd >= 0 ? "+" : ""}${t.grossUsd.toFixed(0)} ` +
        `(net $${(t.grossUsd - t.commissions).toFixed(0)}) · ${s.verdict}`,
    );
  }
  console.log(
    `\nmatched ${matched.length}/${signals.length} · unexecuted ${unexecuted.length} · manual fills ${manual.length} (gross $${manualGross >= 0 ? "+" : ""}${manualGross.toFixed(0)})`,
  );
  console.log(
    `signals gross $${signalsGross >= 0 ? "+" : ""}${signalsGross.toFixed(0)} · account realizedPnl ${accountRealized ?? "n/a"} · netLiq ${accountNet ?? "n/a"}`,
  );

  await sql.end();
}

main().catch((e) => {
  console.error("[reconcile] failed:", e);
  process.exit(1);
});
