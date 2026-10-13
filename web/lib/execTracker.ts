/* ------------------------------------------------------------------ *
 * execTracker — the live execution ledger: one row per executed
 * signal, from card time to closed P&L.
 *
 *   signal card → register (status "placed")
 *              → place failed → "failed"
 *              → entry fill confirmed → "filled" (+ Tradovate order id)
 *              → account went flat → exit fills → pts/gross/fees/net →
 *                "closed" (win | loss | flat)
 *
 * The row links the signal (signalId = signals.key when resolvable) to
 * the Tradovate execution (order id + fill prices) and the money result
 * (net = gross − fees, MNQ $2/pt — the same math as
 * scripts/reconcileTrades.ts, which remains the nightly historical
 * record; this module is the intraday view).
 *
 * Persistence is best-effort (same contract as execLog/signalHistory):
 * in-memory ring first (always visible in-process), then Neon
 * `exec_trades` + a daybook `execTrade` record so redeploys and the
 * DB-less journal keep the evidence. Never throws, never blocks an
 * order, never contains secrets.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { appendDaybook } from "./daybook";

export type ExecTradeStatus = "placed" | "filled" | "closed" | "failed";

export type ExecFill = { ts: number; action: string; qty: number; price: number };

export type ExecTradeRow = {
  /** the watcher's card key (e.g. `reclaim|2026-10-12|short|09:41`) */
  key: string;
  /** signals.key of the linked signal card ("" when unresolvable) */
  signalId: string;
  /** epoch ms at card time */
  ts: number;
  /** NY trading day */
  day: string;
  /** "HH:mm" New York */
  timeET: string;
  label: string;
  family: string;
  side: "long" | "short";
  contracts: number;
  sigEntry: number;
  sigStop: number;
  sigTarget: number;
  /** Tradovate entry order id (from the matched fill) */
  orderId: string;
  status: ExecTradeStatus;
  fillEntry: number | null;
  fillEntryAt: number | null;
  exitAvg: number | null;
  exitFills: ExecFill[];
  /** signed points (exit − entry, long-positive) */
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: "" | "win" | "loss" | "flat";
  updatedAt: number;
};

const MAX_MEMORY = 300;

/* ---- pure helpers (unit-tested) ------------------------------------- */

/** the commission fallback per side ($0.95) — same default as
 *  scripts/reconcileTrades.ts (CT_COMMISSION_PER_SIDE env overrides). */
export function commissionPerSide(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CT_COMMISSION_PER_SIDE ?? "0.95");
  return Number.isFinite(n) ? n : 0.95;
}

/** strategy family from the watcher label's leading token. */
export function familyOfLabel(label: string): string {
  const first = (label ?? "").trim().split(/\s+/)[0] ?? "";
  const known: Record<string, string> = {
    "sweep-reclaim": "sweep_reclaim",
    "pullback-ticket": "pullback_ticket",
    "unusual-volume": "unusual_volume",
    "open-drive": "open_drive",
    "open-pullback": "open_pullback",
    "open-sniper": "open_sniper",
    "gap-alert": "gap_alerts",
  };
  const lower = first.toLowerCase();
  if (known[lower]) return known[lower];
  if (["momentum", "mom"].includes(lower)) return "momentum";
  if (lower === "rth") return "rth";
  if (["open", "drive", "sniper", "pullback"].includes(lower)) return lower === "drive" ? "open_drive" : lower === "sniper" ? "open_sniper" : lower === "pullback" ? "open_pullback" : "open";
  if (lower === "reversal") return "reversal";
  if (lower === "reclaim") return "sweep_reclaim";
  return lower || "other";
}

/** the close math — identical to reconcileTrades.ts: grossUsd =
 *  pts × $2/contract on the capped quantity, fees = real fill fees when
 *  present else contracts × commission/side × 2 sides, net = gross − fees. */
export function computeExecPnl(args: {
  dir: "long" | "short";
  contracts: number;
  entry: number;
  exitAvg: number | null;
  entryFills: ExecFill[];
  exitFills: ExecFill[];
  realFees: number;
  env?: Record<string, string | undefined>;
}): { pts: number | null; grossUsd: number; feesUsd: number; netUsd: number; result: ExecTradeRow["result"] } {
  const { dir, contracts, entry, exitAvg, entryFills, exitFills, realFees, env } = args;
  const sign = dir === "long" ? 1 : -1;
  if (exitAvg === null || !Number.isFinite(exitAvg)) {
    return { pts: null, grossUsd: 0, feesUsd: 0, netUsd: 0, result: "" };
  }
  const entryQty = entryFills.reduce((s, f) => s + f.qty, 0);
  const exitQty = exitFills.reduce((s, f) => s + f.qty, 0);
  // the capped quantity is the ENTRY quantity (reconcileTrades.ts math) —
  // a partial exit never inflates the pts past what was entered
  const qty = entryQty > 0 ? Math.min(entryQty, Math.max(contracts, 1)) : Math.min(exitQty, Math.max(contracts, 1));
  const pts = (exitAvg - entry) * sign * qty;
  const grossUsd = Math.round(pts * 2 * 100) / 100; // MNQ $2/pt
  const totalContracts = entryFills.reduce((s, f) => s + f.qty, 0) + exitQty;
  const feesUsd =
    realFees > 0
      ? Math.round(realFees * 100) / 100
      : Math.round(totalContracts * commissionPerSide(env) * 100) / 100;
  const netUsd = Math.round((grossUsd - feesUsd) * 100) / 100;
  const result: ExecTradeRow["result"] = grossUsd > 0.5 ? "win" : grossUsd < -0.5 ? "loss" : "flat";
  return { pts: Math.round(pts * 100) / 100, grossUsd, feesUsd, netUsd, result };
}

/* ---- in-memory ring (shared across module instances) --------------- */

const g = globalThis as unknown as { __gcExecTrades?: ExecTradeRow[] };
function getMemory(): ExecTradeRow[] {
  if (!g.__gcExecTrades) g.__gcExecTrades = [];
  return g.__gcExecTrades;
}

function upsertMemory(row: ExecTradeRow): void {
  const mem = getMemory();
  const i = mem.findIndex((r) => r.key === row.key);
  if (i >= 0) mem[i] = row;
  else {
    mem.unshift(row);
    if (mem.length > MAX_MEMORY) mem.length = MAX_MEMORY;
  }
}

/* ---- persistence (best-effort) -------------------------------------- */

const TABLE_SQL = `
create table if not exists exec_trades (
  id bigint generated always as identity primary key,
  key text unique not null,
  signal_id text not null default '',
  ts bigint not null,
  day text not null default '',
  time_et text not null default '',
  label text not null default '',
  family text not null default '',
  side text not null default '',
  contracts int not null default 0,
  sig_entry numeric(10,2),
  sig_stop numeric(10,2),
  sig_target numeric(10,2),
  order_id text not null default '',
  status text not null default 'placed',
  fill_entry numeric(10,2),
  fill_entry_at bigint,
  exit_avg numeric(10,2),
  exit_fills jsonb,
  pts numeric(10,2),
  gross_usd numeric(10,2) not null default 0,
  fees_usd numeric(10,2) not null default 0,
  net_usd numeric(10,2) not null default 0,
  result text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists exec_trades_ts_idx on exec_trades (ts desc);
`;

let tableReady = false;

async function ensureTable(): Promise<boolean> {
  if (tableReady) return true;
  if (!dbEnabled()) return false;
  try {
    await getDb().unsafe(TABLE_SQL);
    tableReady = true;
    return true;
  } catch {
    return false;
  }
}

async function persist(row: ExecTradeRow): Promise<void> {
  // daybook hook first — the DB-less journal keeps the execution record
  appendDaybook({
    t: "execTrade",
    at: Date.now(),
    key: row.key,
    signalId: row.signalId,
    day: row.day,
    timeET: row.timeET,
    label: row.label,
    family: row.family,
    side: row.side,
    contracts: row.contracts,
    sigEntry: row.sigEntry,
    sigStop: row.sigStop,
    sigTarget: row.sigTarget,
    orderId: row.orderId,
    status: row.status,
    fillEntry: row.fillEntry,
    fillEntryAt: row.fillEntryAt,
    exitAvg: row.exitAvg,
    pts: row.pts,
    grossUsd: row.grossUsd,
    feesUsd: row.feesUsd,
    netUsd: row.netUsd,
    result: row.result,
  });
  if (!(await ensureTable())) return;
  try {
    await getDb()`
      insert into exec_trades
        (key, signal_id, ts, day, time_et, label, family, side, contracts,
         sig_entry, sig_stop, sig_target, order_id, status, fill_entry, fill_entry_at,
         exit_avg, exit_fills, pts, gross_usd, fees_usd, net_usd, result, updated_at)
      values
        (${row.key}, ${row.signalId}, ${row.ts}, ${row.day}, ${row.timeET}, ${row.label},
         ${row.family}, ${row.side}, ${row.contracts}, ${row.sigEntry}, ${row.sigStop}, ${row.sigTarget},
         ${row.orderId}, ${row.status}, ${row.fillEntry}, ${row.fillEntryAt},
         ${row.exitAvg}, ${JSON.stringify(row.exitFills)}, ${row.pts}, ${row.grossUsd}, ${row.feesUsd}, ${row.netUsd}, ${row.result}, ${new Date(row.updatedAt).toISOString()})
      on conflict (key) do update set
        signal_id = excluded.signal_id, ts = excluded.ts, day = excluded.day, time_et = excluded.time_et,
        label = excluded.label, family = excluded.family, side = excluded.side, contracts = excluded.contracts,
        sig_entry = excluded.sig_entry, sig_stop = excluded.sig_stop, sig_target = excluded.sig_target,
        order_id = excluded.order_id, status = excluded.status, fill_entry = excluded.fill_entry,
        fill_entry_at = excluded.fill_entry_at, exit_avg = excluded.exit_avg, exit_fills = excluded.exit_fills,
        pts = excluded.pts, gross_usd = excluded.gross_usd, fees_usd = excluded.fees_usd,
        net_usd = excluded.net_usd, result = excluded.result, updated_at = excluded.updated_at`;
  } catch {
    /* best-effort — the ring + daybook still hold the row */
  }
}

/* ---- lifecycle hooks (called from execWatch — display/telemetry only) */

export function trackExecRegister(args: {
  key: string;
  ts: number;
  day: string;
  label: string;
  dir: "long" | "short";
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  timeET: string;
  signalId?: string;
}): void {
  const row: ExecTradeRow = {
    key: args.key,
    signalId: args.signalId ?? "",
    ts: args.ts,
    day: args.day,
    timeET: args.timeET,
    label: args.label,
    family: familyOfLabel(args.label),
    side: args.dir,
    contracts: args.contracts,
    sigEntry: args.entry,
    sigStop: args.stop,
    sigTarget: args.target,
    orderId: "",
    status: "placed",
    fillEntry: null,
    fillEntryAt: null,
    exitAvg: null,
    exitFills: [],
    pts: null,
    grossUsd: 0,
    feesUsd: 0,
    netUsd: 0,
    result: "",
    updatedAt: Date.now(),
  };
  upsertMemory(row);
  void persist(row);
}

export function trackExecFail(key: string, _reason: string): void {
  const mem = getMemory();
  const i = mem.findIndex((r) => r.key === key);
  if (i < 0) return;
  const row = { ...mem[i], status: "failed" as const, updatedAt: Date.now() };
  upsertMemory(row);
  void persist(row);
}

/** entry fill confirmed — attach the broker fill + Tradovate order id.
 *  `fills` is the shared ctAccount fill list (5s cache); the matched
 *  fill's orderId is the Tradovate entry order. Resolves rows that are
 *  NOT in this process's memory too (orphan sweep after a redeploy). */
export async function trackExecFill(
  key: string,
  fill: { ts: number; action: string; qty: number; price: number },
  allFills?: Array<{ ts: number; action: string; qty: number; price: number; orderId: string }> | null,
): Promise<void> {
  const row = await readRow(key);
  if (!row) return;
  const matched =
    allFills?.find((f) => f.ts === fill.ts && f.action === fill.action && f.qty === fill.qty && f.price === fill.price) ??
    null;
  const next: ExecTradeRow = {
    ...row,
    status: "filled",
    fillEntry: fill.price,
    fillEntryAt: fill.ts,
    orderId: matched?.orderId ?? row.orderId,
    updatedAt: Date.now(),
  };
  upsertMemory(next);
  void persist(next);
}

/** the account went flat — exit fills are the opposite-side session
 *  fills since the entry. Computes and stores the money result. Resolves
 *  rows that are NOT in this process's memory too (orphan sweep). */
export async function trackExecClose(
  key: string,
  opts: {
    entry: number;
    dir: "long" | "short";
    contracts: number;
    exitFills: ExecFill[];
    realFees: number;
  },
): Promise<void> {
  const row = await readRow(key);
  if (!row) return;
  const exitQty = opts.exitFills.reduce((s, f) => s + f.qty, 0);
  if (exitQty <= 0) return; // no exit fills visible yet — keep the row open
  const exitAvg = opts.exitFills.reduce((s, f) => s + f.price * f.qty, 0) / exitQty;
  const entry = row.fillEntry ?? opts.entry;
  const pnl = computeExecPnl({
    dir: opts.dir,
    contracts: opts.contracts,
    entry,
    exitAvg,
    entryFills: row.fillEntryAt !== null ? [{ ts: row.fillEntryAt, action: opts.dir === "long" ? "Buy" : "Sell", qty: opts.contracts, price: row.fillEntry ?? entry }] : [],
    exitFills: opts.exitFills,
    realFees: opts.realFees,
  });
  const closed: ExecTradeRow = {
    ...row,
    status: "closed",
    exitAvg: Math.round(exitAvg * 100) / 100,
    exitFills: opts.exitFills.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price })),
    pts: pnl.pts,
    grossUsd: pnl.grossUsd,
    feesUsd: pnl.feesUsd,
    netUsd: pnl.netUsd,
    result: pnl.result,
    updatedAt: Date.now(),
  };
  upsertMemory(closed);
  void persist(closed);
}

/* ---- reads ----------------------------------------------------------- */

export function execTradesMemory(): ExecTradeRow[] {
  return getMemory();
}

type DbRow = {
  key: string;
  signal_id: string;
  ts: string;
  day: string;
  time_et: string;
  label: string;
  family: string;
  side: string;
  contracts: number;
  sig_entry: string | number | null;
  sig_stop: string | number | null;
  sig_target: string | number | null;
  order_id: string;
  status: string;
  fill_entry: string | number | null;
  fill_entry_at: string | number | null;
  exit_avg: string | number | null;
  exit_fills: unknown;
  pts: string | number | null;
  gross_usd: string | number;
  fees_usd: string | number;
  net_usd: string | number;
  result: string;
};

function mapDbRow(r: DbRow): ExecTradeRow {
  let exitFills: ExecFill[] = [];
  if (r.exit_fills !== null && r.exit_fills !== undefined) {
    try {
      exitFills = (typeof r.exit_fills === "string" ? JSON.parse(r.exit_fills) : r.exit_fills) as ExecFill[];
    } catch {
      exitFills = [];
    }
  }
  const numOr = (v: string | number | null | undefined, fallback: number | null): number | null =>
    v === null || v === undefined || !Number.isFinite(Number(v)) ? fallback : Number(v);
  return {
    key: r.key,
    signalId: r.signal_id ?? "",
    ts: Number(r.ts),
    day: r.day,
    timeET: r.time_et,
    label: r.label,
    family: r.family,
    side: (r.side === "long" ? "long" : "short") as "long" | "short",
    contracts: Number(r.contracts ?? 0),
    sigEntry: numOr(r.sig_entry, 0) ?? 0,
    sigStop: numOr(r.sig_stop, 0) ?? 0,
    sigTarget: numOr(r.sig_target, 0) ?? 0,
    orderId: r.order_id ?? "",
    status: (["placed", "filled", "closed", "failed"].includes(r.status) ? r.status : "placed") as ExecTradeStatus,
    fillEntry: numOr(r.fill_entry, null),
    fillEntryAt: numOr(r.fill_entry_at, null),
    exitAvg: numOr(r.exit_avg, null),
    exitFills,
    pts: numOr(r.pts, null),
    grossUsd: Number(r.gross_usd ?? 0),
    feesUsd: Number(r.fees_usd ?? 0),
    netUsd: Number(r.net_usd ?? 0),
    result: (["win", "loss", "flat"].includes(r.result) ? r.result : "") as ExecTradeRow["result"],
    updatedAt: 0,
  };
}

/** one row by key — memory first (newest, recorded this process), then
 *  the DB. Lets the orphan sweep re-attach rows a previous process left
 *  unresolved (a redeploy wipes the in-memory ring, not the table). */
async function readRow(key: string): Promise<ExecTradeRow | null> {
  const mem = getMemory();
  const i = mem.findIndex((r) => r.key === key);
  if (i >= 0) return mem[i];
  if (!(await ensureTable())) return null;
  try {
    const rows = (await getDb()`
      select key, signal_id, ts, day, time_et, label, family, side, contracts,
             sig_entry, sig_stop, sig_target, order_id, status, fill_entry, fill_entry_at,
             exit_avg, exit_fills, pts, gross_usd, fees_usd, net_usd, result
      from exec_trades where key = ${key} limit 1`) as unknown as DbRow[];
    return rows.length ? mapDbRow(rows[0]) : null;
  } catch {
    return null;
  }
}

/** memory first (newest, recorded this process), then older DB rows
 *  from earlier processes — the same merge pattern as getSignalHistory. */
export async function getExecTrades(limit = 200): Promise<ExecTradeRow[]> {
  const mem = getMemory();
  const out: ExecTradeRow[] = [...mem];
  if (await ensureTable()) {
    try {
      const rows = (await getDb()`
        select key, signal_id, ts, day, time_et, label, family, side, contracts,
               sig_entry, sig_stop, sig_target, order_id, status, fill_entry, fill_entry_at,
               exit_avg, exit_fills, pts, gross_usd, fees_usd, net_usd, result
        from exec_trades order by ts desc limit ${limit}`) as unknown as DbRow[];
      const seen = new Set(mem.map((m) => m.key));
      for (const r of rows) {
        if (seen.has(r.key)) continue;
        out.push(mapDbRow(r));
      }
    } catch {
      /* DB read failed — return what memory has */
    }
  }
  return out.slice(0, limit);
}

/** TEST ONLY: reset the tracker state. */
export function __resetExecTrackerForTest() {
  getMemory().length = 0;
  tableReady = false;
}
