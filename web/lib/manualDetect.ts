/* ------------------------------------------------------------------ *
 * manualDetect — the unified manual-action detector.
 *
 * The bot knows exactly what IT did (lib/execTracker.ts: card → fill →
 * close). Everything else that touches the MNQ book is a MANUAL action:
 *
 *   manual_trade  — an MNQ round trip whose fills belong to no tracked
 *                   trade (user entered and/or exited by hand)
 *   manual_order  — a working MNQ order the bot didn't place (manual
 *                   resting limit/stop, cancel-replace, bracket edit)
 *
 * Detection runs on its own 10s timer (started from instrumentation,
 * gated on CROSSTRADE_KEY + CROSSTRADE_ACCOUNT — independent of
 * EXECUTE_LIVE, so manual activity is visible in dry-run too):
 *
 *   1. shared fills read (ctAccount, 5s cache) → MNQ fills not claimed
 *      by a tracked trade (entry orderId match or exact exit-fill
 *      match) are manual
 *   2. manual fills grouped by orderId → open manual positions become
 *      manual_trade rows; buy+sell balance closes them with the $ P&L
 *      (same math as the reconcile: pts × $2 − fees)
 *   3. positions read → an MNQ position with no tracked trade AND no
 *      manual row → manual_trade row from the position rows
 *   4. orders read → working MNQ orders whose id the bot never placed
 *      → manual_order rows (our resting-limit ids are excluded via
 *      execWatch.placedLimitOrderIds)
 *
 * New manual activity alerts via Telegram once per key. Persistence is
 * best-effort: in-memory ring first, then Neon `manual_actions` + a
 * daybook `manualAction` record. Never throws, never blocks anything.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { appendDaybook } from "./daybook";
import { ctFills, ctOrders, ctOrdersHistory, ctPositions, type CtFill, type CtOrderHist } from "./ctAccount";
import { execTradesMemory, getExecTrades } from "./execTracker";
import { placedLimitOrderIds } from "./execWatch";
import { sendTelegram } from "./notify";

export type ManualActionRow = {
  /** round trips: `fill|<orderId>` · order events: `ord|<orderId>` */
  key: string;
  kind: "manual_trade" | "manual_order";
  /** epoch ms first seen */
  at: number;
  day: string;
  timeET: string;
  side: "long" | "short" | "";
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  /** net $ — real fill fees when present, else the reconcile fallback */
  pnlUsd: number | null;
  orderId: string;
  fills: Array<{ ts: number; action: string; qty: number; price: number }>;
  /** trade round trips only: false while the position is open */
  closed: boolean;
  note: string;
  updatedAt: number;
};

const MAX_MEMORY = 200;
const MNQ = "MNQ";

/* ---- pure helpers (unit-tested) ------------------------------------- */

export type TrackedTrade = {
  orderId: string;
  side: "long" | "short";
  contracts: number;
  fillEntryAt: number | null;
  exitFills: Array<{ ts: number; action: string; qty: number; price: number }>;
};

/** a fill is claimed by the bot when its orderId is a tracked entry
 *  order, or when it exactly matches a tracked exit fill (same source
 *  list the tracker recorded, so ts/action/qty are identical). */
export function isBotFill(
  f: Pick<CtFill, "ts" | "action" | "qty" | "price" | "orderId">,
  tracked: TrackedTrade[],
  consumed: Map<number, number>,
): boolean {
  for (let i = 0; i < tracked.length; i++) {
    const t = tracked[i];
    if (t.orderId && f.orderId === t.orderId) return true;
    if (!f.orderId) continue;
    for (let j = 0; j < t.exitFills.length; j++) {
      const e = t.exitFills[j];
      const key = i * 10_000 + j;
      const used = consumed.get(key) ?? 0;
      if (used >= e.qty) continue;
      if (f.action === e.action && f.ts === e.ts && Math.abs(f.price - e.price) < 0.01) {
        consumed.set(key, used + f.qty);
        return true;
      }
    }
  }
  return false;
}

/** split MNQ fills into bot vs manual. Entry fills of tracked trades are
 *  claimed by orderId; exit fills by exact match. Everything else on the
 *  MNQ book is a manual action. */
export function classifyManualFills(
  fills: Pick<CtFill, "ts" | "action" | "qty" | "price" | "orderId" | "instrument" | "commission" | "fees">[],
  tracked: TrackedTrade[],
): { bot: typeof fills; manual: typeof fills } {
  const bot: typeof fills = [];
  const manual: typeof fills = [];
  const consumed = new Map<number, number>();
  for (const f of fills) {
    if (!f.instrument.toUpperCase().includes(MNQ)) continue;
    if (isBotFill(f, tracked, consumed)) bot.push(f);
    else manual.push(f);
  }
  return { bot, manual };
}

/** one manual round trip (grouped by orderId): entry = the first fill's
 *  side, exits = the rest. Open (one-sided) → closed=false. */
export function pairManualGroup(fills: Pick<CtFill, "ts" | "action" | "qty" | "price" | "commission" | "fees">[]): {
  side: "long" | "short" | "";
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  closed: boolean;
  realFees: number;
} {
  if (fills.length === 0) return { side: "", qty: 0, entryPrice: null, exitPrice: null, pnlUsd: null, closed: false, realFees: 0 };
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  const first = sorted[0];
  const side: "long" | "short" = first.action === "Buy" ? "long" : "short";
  const entrySide = first.action;
  const entries = sorted.filter((f) => f.action === entrySide);
  const exits = sorted.filter((f) => f.action !== entrySide);
  const entryQty = entries.reduce((s, f) => s + f.qty, 0);
  const exitQty = exits.reduce((s, f) => s + f.qty, 0);
  const entryAvg = entries.reduce((s, f) => s + f.price * f.qty, 0) / Math.max(entryQty, 1);
  const realFees = sorted.reduce((s, f) => s + f.commission + f.fees, 0);
  // open until the exits COVER the entry — a partial exit is still an
  // open position, never a closed round trip
  if (exitQty < entryQty) {
    return { side, qty: entryQty, entryPrice: entryAvg, exitPrice: null, pnlUsd: null, closed: false, realFees };
  }
  const exitAvg = exits.reduce((s, f) => s + f.price * f.qty, 0) / Math.max(exitQty, 1);
  const dir = side === "long" ? 1 : -1;
  const qty = Math.min(entryQty, exitQty);
  const pts = (exitAvg - entryAvg) * dir * qty;
  const grossUsd = pts * 2; // MNQ $2/pt
  const fallback = Number(process.env.CT_COMMISSION_PER_SIDE ?? "0.95");
  const fees = realFees > 0 ? realFees : (entryQty + exitQty) * (Number.isFinite(fallback) ? fallback : 0.95);
  return {
    side,
    qty,
    entryPrice: Math.round(entryAvg * 100) / 100,
    exitPrice: Math.round(exitAvg * 100) / 100,
    pnlUsd: Math.round((grossUsd - fees) * 100) / 100,
    closed: true,
    realFees,
  };
}

/** group manual fills into round trips. With the session order list
 *  (parentage): every fill folds into its TOP-LEVEL order — a child
 *  exit leg (stop/target) belongs to the parent entry, so one manual
 *  trade = one group even though each leg carries its own orderId.
 *  Without orders (session reset): chronological fallback — same-side
 *  fills accumulate, the opposite side closes the trip once the
 *  quantity is covered. */
export function groupManualFills(
  manual: Pick<CtFill, "ts" | "action" | "qty" | "price" | "orderId" | "commission" | "fees">[],
  orders: CtOrderHist[] | null,
): Map<string, typeof manual> {
  const groups = new Map<string, typeof manual>();
  const push = (key: string, f: (typeof manual)[number]) => {
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  };
  if (orders && orders.length) {
    const byId = new Map(orders.map((o) => [o.id, o]));
    for (const f of manual) {
      const own = f.orderId ? byId.get(f.orderId) : undefined;
      const root = own?.parentId ? byId.get(own.parentId)?.id ?? f.orderId : f.orderId;
      push(root || `nf|${f.ts}`, f);
    }
    return groups;
  }
  // chronological fallback (bounded, side-alternating — never invents
  // trades, and a partial exit keeps the trip open until covered)
  const sorted = [...manual].sort((a, b) => a.ts - b.ts);
  let open: { side: string; key: string; qty: number } | null = null;
  for (const f of sorted) {
    if (!open) {
      open = { side: f.action, key: `fill|${f.ts}|${f.action}|${f.qty}`, qty: f.qty };
      push(open.key, f);
      continue;
    }
    if (f.action === open.side) {
      open.qty += f.qty;
      push(open.key, f);
      continue;
    }
    push(open.key, f);
    open.qty -= f.qty;
    if (open.qty <= 0) open = null;
  }
  return groups;
}

/** NEW YORK day + "HH:mm" for an epoch ms (mirrors execWatch.nyDay). */
export function nyDay(ts: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ts));
    const g: Record<string, string> = {};
    for (const p of parts) g[p.type] = p.value;
    return `${g.year}-${g.month}-${g.day}`;
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function nyTime(ts: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(ts));
    const g: Record<string, string> = {};
    for (const p of parts) g[p.type] = p.value;
    return `${g.hour}:${g.minute}`;
  } catch {
    return "";
  }
}

/* ---- in-memory ring (shared across module instances) ----------------- */

const g = globalThis as unknown as { __gcManualActions?: ManualActionRow[] };
function getMemory(): ManualActionRow[] {
  if (!g.__gcManualActions) g.__gcManualActions = [];
  return g.__gcManualActions;
}

function upsertMemory(row: ManualActionRow): void {
  const mem = getMemory();
  const i = mem.findIndex((r) => r.key === row.key);
  if (i >= 0) mem[i] = row;
  else {
    mem.unshift(row);
    if (mem.length > MAX_MEMORY) mem.length = MAX_MEMORY;
  }
}

const alerted = new Set<string>();

/* ---- persistence (best-effort) --------------------------------------- */

const TABLE_SQL = `
create table if not exists manual_actions (
  id bigint generated always as identity primary key,
  key text unique not null,
  kind text not null default 'manual_trade',
  at bigint not null,
  day text not null default '',
  time_et text not null default '',
  side text not null default '',
  qty numeric(10,2) not null default 0,
  entry_price numeric(10,2),
  exit_price numeric(10,2),
  pnl_usd numeric(10,2),
  order_id text not null default '',
  fills jsonb,
  closed boolean not null default false,
  note text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists manual_actions_at_idx on manual_actions (at desc);
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

async function persist(row: ManualActionRow): Promise<void> {
  appendDaybook({
    t: "manualAction",
    at: Date.now(),
    key: row.key,
    kind: row.kind,
    eventAt: row.at,
    day: row.day,
    timeET: row.timeET,
    side: row.side,
    qty: row.qty,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    pnlUsd: row.pnlUsd,
    orderId: row.orderId,
    closed: row.closed,
    note: row.note,
  });
  if (!(await ensureTable())) return;
  try {
    await getDb()`
      insert into manual_actions
        (key, kind, at, day, time_et, side, qty, entry_price, exit_price, pnl_usd, order_id, fills, closed, note, updated_at)
      values
        (${row.key}, ${row.kind}, ${row.at}, ${row.day}, ${row.timeET}, ${row.side}, ${row.qty},
         ${row.entryPrice}, ${row.exitPrice}, ${row.pnlUsd}, ${row.orderId}, ${JSON.stringify(row.fills)},
         ${row.closed}, ${row.note}, ${new Date(row.updatedAt).toISOString()})
      on conflict (key) do update set
        kind = excluded.kind, at = excluded.at, day = excluded.day, time_et = excluded.time_et,
        side = excluded.side, qty = excluded.qty, entry_price = excluded.entry_price,
        exit_price = excluded.exit_price, pnl_usd = excluded.pnl_usd, order_id = excluded.order_id,
        fills = excluded.fills, closed = excluded.closed, note = excluded.note, updated_at = excluded.updated_at`;
  } catch {
    /* best-effort — ring + daybook still hold the row */
  }
}

/* ---- detection -------------------------------------------------------- */

function telegramOn(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;
}

function alertOnce(key: string, text: string): void {
  if (!telegramOn() || alerted.has(key)) return;
  alerted.add(key);
  void sendTelegram(text, { parseMode: "HTML" }).catch(() => {});
}

/** the bot's tracked trades — memory AND the persisted ledger (Neon
 *  exec_trades), so a redeploy never turns the bot's own history into
 *  "manual" rows. */
async function trackedTrades(): Promise<TrackedTrade[]> {
  const rows = await getExecTrades(200);
  return rows
    .filter((r) => r.status === "filled" || r.status === "closed")
    .map((r) => ({
      orderId: r.orderId,
      side: r.side,
      contracts: r.contracts,
      fillEntryAt: r.fillEntryAt,
      exitFills: r.exitFills,
    }));
}

function openTrackedTrade(): boolean {
  return execTradesMemory().some((r) => r.status === "filled");
}

/** one detection pass — call on the 10s timer. Best-effort, never throws. */
export async function checkManualActions(): Promise<void> {
  try {
    // positions first: the held side decides whether a one-sided manual
    // group is a REAL open position or an exit that left the fill window
    const posRows = await ctPositions();
    let held: "long" | "short" | null = null;
    let posNet = 0;
    if (posRows) {
      const mnq = posRows.filter((p) => {
        const qty = Number(p.netPos ?? p.qty ?? 0);
        const ins = String(p.instrument ?? p.contractName ?? "");
        return qty !== 0 && ins.toUpperCase().includes(MNQ);
      });
      posNet = mnq.reduce((s, p) => s + Number(p.netPos ?? p.qty ?? 0), 0);
      if (posNet !== 0) held = posNet > 0 ? "long" : "short";
    }

    const fills = await ctFills();
    const tracked = await trackedTrades();
    if (fills) {
      const { manual } = classifyManualFills(fills, tracked);
      // parentage-aware grouping (orders history), chronological fallback
      const groups = groupManualFills(manual, await ctOrdersHistory());
      for (const [oid, fs] of groups) {
        let pair = pairManualGroup(fs);
        const key = `fill|${oid}`;
        const existing = getMemory().find((r) => r.key === key);
        let zombieClosed = false;
        if (!pair.closed) {
          const lastTs = Math.max(...fs.map((f) => f.ts));
          // flat (or opposite) account + an old one-sided group = the exit
          // fills rolled out of the session window — close without net
          if (held !== pair.side && Date.now() - lastTs > 15 * 60_000) {
            zombieClosed = true;
            pair = { ...pair, closed: true, pnlUsd: null };
          }
        }
        const row: ManualActionRow = {
          key,
          kind: "manual_trade",
          at: existing?.at ?? fs[0].ts,
          day: nyDay(fs[0].ts),
          timeET: nyTime(fs[0].ts),
          side: pair.side,
          qty: pair.qty,
          entryPrice: pair.entryPrice,
          exitPrice: pair.exitPrice,
          pnlUsd: pair.pnlUsd,
          orderId: String(oid),
          fills: fs.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price })),
          closed: pair.closed,
          note: zombieClosed
            ? "exit fills outside the session fill window — net unknown"
            : pair.closed
              ? "manual round trip — fills belong to no tracked trade"
              : "manual position open — fills belong to no tracked trade",
          updatedAt: Date.now(),
        };
        upsertMemory(row);
        void persist(row);
        if (!existing) {
          alertOnce(
            key,
            `🖐 <b>MANUAL ${pair.closed && !zombieClosed ? "TRADE" : "POSITION OPEN"}</b> — <code>${oid}</code>\n` +
              `${pair.side.toUpperCase()} ${pair.qty} MNQ${pair.entryPrice !== null ? ` @ ${pair.entryPrice.toFixed(2)}` : ""}` +
              (pair.closed && !zombieClosed && pair.pnlUsd !== null
                ? ` → ${pair.exitPrice?.toFixed(2)} · net ${pair.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pair.pnlUsd).toFixed(2)}`
                : ""),
          );
        } else if (!existing.closed && pair.closed && !zombieClosed) {
          alertOnce(
            `${key}|close`,
            `🖐 <b>MANUAL TRADE CLOSED</b> — <code>${oid}</code> ${pair.side.toUpperCase()} ${pair.qty} → ${pair.exitPrice?.toFixed(2)} · net ${pair.pnlUsd !== null && pair.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pair.pnlUsd ?? 0).toFixed(2)}`,
          );
        }
      }
    }

    // positions: an MNQ position with no tracked trade and no manual row
    if (posNet !== 0 && !openTrackedTrade()) {
      const hasManualOpen = getMemory().some((r) => r.kind === "manual_trade" && !r.closed);
      if (!hasManualOpen) {
        const now = Date.now();
        const key = `pos|${nyDay(now)}|${posNet > 0 ? "long" : "short"}`;
        if (!getMemory().some((r) => r.key === key)) {
          const row: ManualActionRow = {
            key,
            kind: "manual_trade",
            at: now,
            day: nyDay(now),
            timeET: nyTime(now),
            side: posNet > 0 ? "long" : "short",
            qty: Math.abs(posNet),
            entryPrice: null,
            exitPrice: null,
            pnlUsd: null,
            orderId: "",
            fills: [],
            closed: false,
            note: "manual position — no tracked bracket (entry fill not in the session list)",
            updatedAt: now,
          };
          upsertMemory(row);
          void persist(row);
          alertOnce(
            key,
            `🖐 <b>MANUAL MNQ POSITION</b> — ${row.side.toUpperCase()} ${row.qty} with no tracked bracket — verify manually`,
          );
        }
      }
    }

    // orders: working MNQ orders the bot never placed
    const ords = await ctOrders();
    if (ords.ok) {
      const known = new Set<string>([
        ...tracked.map((t) => t.orderId).filter(Boolean),
        ...placedLimitOrderIds(),
      ]);
      const working = ords.orders.filter((o) => {
        const ins = String(o.instrument ?? o.contractName ?? "");
        const status = String(o.ordStatus ?? o.status ?? "").toLowerCase();
        return ins.toUpperCase().includes(MNQ) && (status === "working" || status === "");
      });
      for (const o of working) {
        const oid = String(o.id ?? "");
        if (!oid || known.has(oid)) continue;
        const key = `ord|${oid}`;
        if (getMemory().some((r) => r.key === key)) continue;
        const now = Date.now();
        const row: ManualActionRow = {
          key,
          kind: "manual_order",
          at: now,
          day: nyDay(now),
          timeET: nyTime(now),
          side: String(o.action ?? "").toLowerCase() === "buy" ? "long" : String(o.action ?? "").toLowerCase() === "sell" ? "short" : "",
          qty: Number(o.qty ?? 0),
          entryPrice: o.stopPrice !== undefined && o.stopPrice !== null ? Number(o.stopPrice) : null,
          exitPrice: null,
          pnlUsd: null,
          orderId: oid,
          fills: [],
          closed: false,
          note: `manual working order (${String(o.orderType ?? o.type ?? "unknown")}) — the bot did not place it`,
          updatedAt: now,
        };
        upsertMemory(row);
        void persist(row);
        alertOnce(key, `🖐 <b>MANUAL WORKING ORDER</b> — <code>${oid}</code> ${String(o.orderType ?? "")} ${String(o.action ?? "")} ${Number(o.qty ?? 0)} MNQ — the bot did not place it`);
      }
    }
  } catch (e) {
    console.error("[manualDetect] pass failed:", (e as Error).message ?? e);
  }
}

/* ---- lifecycle + reads ------------------------------------------------- */

let started = false;

/** the 10s manual-action detector. Independent of EXECUTE_LIVE — manual
 *  activity matters most precisely when the bot is NOT trading. */
export function startManualDetect(intervalMs = 10_000): void {
  if (started) return;
  const key = (process.env.CROSSTRADE_KEY ?? "").trim();
  const acct = (process.env.CROSSTRADE_ACCOUNT ?? "").trim();
  if (!key || !acct) return;
  started = true;
  const timer = setInterval(() => {
    void checkManualActions().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

export function manualActionsMemory(): ManualActionRow[] {
  return getMemory();
}

type DbRow = {
  key: string;
  kind: string;
  at: string;
  day: string;
  time_et: string;
  side: string;
  qty: string | number;
  entry_price: string | number | null;
  exit_price: string | number | null;
  pnl_usd: string | number | null;
  order_id: string;
  fills: unknown;
  closed: boolean;
  note: string;
};

function mapDbRow(r: DbRow): ManualActionRow {
  let fills: ManualActionRow["fills"] = [];
  if (r.fills !== null && r.fills !== undefined) {
    try {
      fills = (typeof r.fills === "string" ? JSON.parse(r.fills) : r.fills) as ManualActionRow["fills"];
    } catch {
      fills = [];
    }
  }
  const numOr = (v: string | number | null | undefined): number | null =>
    v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    key: r.key,
    kind: r.kind === "manual_order" ? "manual_order" : "manual_trade",
    at: Number(r.at),
    day: r.day,
    timeET: r.time_et,
    side: r.side === "long" || r.side === "short" ? r.side : "",
    qty: Number(r.qty ?? 0),
    entryPrice: numOr(r.entry_price),
    exitPrice: numOr(r.exit_price),
    pnlUsd: numOr(r.pnl_usd),
    orderId: r.order_id ?? "",
    fills,
    closed: !!r.closed,
    note: r.note ?? "",
    updatedAt: 0,
  };
}

/** memory first, then older DB rows — the same merge as execTracker. */
export async function getManualActions(limit = 200): Promise<ManualActionRow[]> {
  const mem = getMemory();
  const out: ManualActionRow[] = [...mem];
  if (await ensureTable()) {
    try {
      const rows = (await getDb()`
        select key, kind, at, day, time_et, side, qty, entry_price, exit_price, pnl_usd, order_id, fills, closed, note
        from manual_actions order by at desc limit ${limit}`) as unknown as DbRow[];
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

/** TEST ONLY: reset the detector state. */
export function __resetManualDetectForTest() {
  getMemory().length = 0;
  alerted.clear();
  started = false;
  tableReady = false;
}
