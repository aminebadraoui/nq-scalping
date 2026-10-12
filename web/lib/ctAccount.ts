/* ------------------------------------------------------------------ *
 * ctAccount — the ONE read layer for CrossTrade account + book data.
 *
 * Every display/gate/observational path that needs the linked account's
 * numbers (netLiq, realized, open P&L), fills, orders or positions goes
 * through this module, so all tabs agree on the same numbers from the
 * same cached reads:
 *
 *   accounts/snapshot  — 30s cache (the guard's window; fail stores a
 *                        null so callers fail closed like crossGuard)
 *   /v1/api/tv/fills   — 5s cache (the watcher's fill-match window)
 *   accounts/<id>/positions — 2s cache (protection sweep window)
 *   accounts/<id>/orders    — always fresh (protection checks)
 *
 * Callers with stricter needs (the entry flat-gate, the exactly-once
 * re-send verification) must NOT read through these caches — they keep
 * their own fresh fetches. This module is for the shared/observational
 * reads only. Display-only code never fetches the API itself anymore.
 * ------------------------------------------------------------------ */

export type CtSnapshotAccount = {
  name?: string;
  /** the numeric Tradovate account id — the exact identity key */
  accountId?: string | number | null;
  environment?: string | null;
  broker?: string | null;
  netLiq?: number;
  openPnl?: number;
  realizedPnl?: number;
  weekRealizedPnl?: number;
};

export type CtSnapshot = {
  at: number;
  accounts: CtSnapshotAccount[] | null;
};

/** one CrossTrade session fill — the full row (orderId/instrument/fees
 *  kept; the watcher's legacy compact shape is a subset of this) */
export type CtFill = {
  ts: number; // epoch ms
  action: string; // "Buy" | "Sell"
  qty: number;
  price: number;
  orderId: string;
  instrument: string;
  commission: number;
  fees: number;
};

const SNAPSHOT_TTL_MS = 30_000;
const FILLS_TTL_MS = 5_000;
const POSITIONS_TTL_MS = 2_000;

let snapCache: CtSnapshot | null = null;
let fillsCache: { at: number; fills: CtFill[] | null } | null = null;
let positionsCache: { at: number; rows: Record<string, unknown>[] | null } | null = null;

function ctKey(env: Record<string, string | undefined> = process.env): string {
  return (env.CROSSTRADE_KEY ?? "").trim();
}

export function configuredAccount(env: Record<string, string | undefined> = process.env): string {
  return (env.CROSSTRADE_ACCOUNT ?? "").trim();
}

function enabled(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.CROSSTRADE_URL && !!env.CROSSTRADE_KEY && !!env.CROSSTRADE_ACCOUNT;
}

/* ---- account snapshot (30s) ---------------------------------------- */

async function fetchSnapshotRaw(fetchFn: typeof fetch): Promise<CtSnapshotAccount[]> {
  const res = await fetchFn("https://app.crosstrade.io/v1/api/tv/accounts/snapshot", {
    headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const j = (await res.json()) as { accounts?: CtSnapshotAccount[] };
  return j.accounts ?? [];
}

/** Is this accounts array a USABLE read for the configured account? A
 *  usable read has the account row AND finite netLiq/realizedPnl (the two
 *  fields the guard maps). The vendor's snapshot endpoint flaps between
 *  real numbers and a degraded "balance refresh in progress" state that
 *  returns HTTP 200 with the row but NULL balances — that degraded shape
 *  is exactly as unusable as a fetch error and must be retried, not
 *  cached. */
function snapshotUsable(accounts: CtSnapshotAccount[] | null, account: string): boolean {
  if (!Array.isArray(accounts)) return false;
  const row = accountRow({ at: 0, accounts }, account);
  return !!row && Number.isFinite(row.netLiq) && Number.isFinite(row.realizedPnl);
}

const SNAP_MAX_ATTEMPTS = 3;
const SNAP_RETRY_BASE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** the shared snapshot read: cached 30s, refreshed on expiry, null-cached
 *  on failure (the same fail-closed shape the guard relied on).
 *
 *  2026-10-12 fix — retry degraded reads: the CrossTrade snapshot API
 *  intermittently returns the account row with netLiq/realizedPnl = null
 *  (or an empty body) even though the numbers exist moments later. One
 *  degraded sample used to null-cache for 30s and halt the gate for
 *  hours. Now up to SNAP_MAX_ATTEMPTS reads are taken (small backoff
 *  between them) and a null-cache happens ONLY when every attempt came
 *  back degraded or failed — the gate still fails closed, but only when
 *  the account is genuinely unreadable. */
export async function ctSnapshot(opts?: { fetchFn?: typeof fetch; retryDelayMs?: number }): Promise<CtSnapshot> {
  if (snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache;
  const fetchFn = opts?.fetchFn ?? fetch;
  const account = configuredAccount();
  for (let attempt = 1; attempt <= SNAP_MAX_ATTEMPTS; attempt++) {
    try {
      const accounts = await fetchSnapshotRaw(fetchFn);
      if (snapshotUsable(accounts, account)) {
        snapCache = { at: Date.now(), accounts };
        return snapCache;
      }
      // 200 with null balances / missing row / empty list — retry
    } catch {
      // HTTP error, empty body, or timeout — retry
    }
    if (attempt < SNAP_MAX_ATTEMPTS) {
      await sleep(opts?.retryDelayMs ?? attempt * SNAP_RETRY_BASE_MS);
    }
  }
  // every attempt failed or came back degraded — null-cache (fail closed)
  snapCache = { at: Date.now(), accounts: null };
  return snapCache;
}

/** DISPLAY-ONLY cached read (no fetch, no refresh) — what the last
 *  successful snapshot showed. Null until the first fetch lands. */
export function ctSnapshotDisplay(): CtSnapshot | null {
  return snapCache && snapCache.accounts ? snapCache : null;
}

/** the configured account row from a snapshot (by name, case-insensitive) */
export function accountRow(snap: CtSnapshot, account: string): CtSnapshotAccount | null {
  const name = account.trim().toUpperCase();
  if (!name || !snap.accounts) return null;
  return snap.accounts.find((a) => (a.name ?? "").trim().toUpperCase() === name) ?? null;
}

/* ---- fills (5s, the watcher's window) ------------------------------- */

async function fetchFillsRaw(fetchFn: typeof fetch): Promise<CtFill[]> {
  const res = await fetchFn("https://app.crosstrade.io/v1/api/tv/fills", {
    headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`fills ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
  const fills: CtFill[] = [];
  for (const env of j.data ?? []) {
    for (const f of env.data ?? []) {
      const ts = Date.parse(String(f.timestamp ?? ""));
      if (!Number.isFinite(ts)) continue;
      fills.push({
        ts,
        action: String(f.action ?? ""),
        qty: Number(f.qty ?? 0),
        price: Number(f.price ?? 0),
        orderId: String(f.orderId ?? f.id ?? ""),
        instrument: String(f.instrument ?? f.contractName ?? ""),
        commission: Number(f.commission ?? 0),
        fees: Number(f.fees ?? 0),
      });
    }
  }
  return fills;
}

/** shared fills read: 5s cache; on failure the last successful list is
 *  returned (the watcher's fallback semantics), null when none exists. */
export async function ctFills(opts?: { force?: boolean; fetchFn?: typeof fetch }): Promise<CtFill[] | null> {
  if (!opts?.force && fillsCache && Date.now() - fillsCache.at < FILLS_TTL_MS) return fillsCache.fills;
  try {
    const fills = await fetchFillsRaw(opts?.fetchFn ?? fetch);
    fillsCache = { at: Date.now(), fills };
    return fills;
  } catch {
    return fillsCache?.fills ?? null;
  }
}

/* ---- positions (2s, protection sweep) ------------------------------- */

async function fetchPositionsRaw(fetchFn: typeof fetch): Promise<Record<string, unknown>[]> {
  const res = await fetchFn(
    `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(configuredAccount())}/positions`,
    {
      headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`positions ${res.status}`);
  const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
  if (!j.success) throw new Error("positions read failed");
  return j.data ?? [];
}

/** shared positions read: 2s cache; failure null-caches (unreadable). */
export async function ctPositions(opts?: { fetchFn?: typeof fetch }): Promise<Record<string, unknown>[] | null> {
  if (positionsCache && Date.now() - positionsCache.at < POSITIONS_TTL_MS) return positionsCache.rows;
  try {
    const rows = await fetchPositionsRaw(opts?.fetchFn ?? fetch);
    positionsCache = { at: Date.now(), rows };
    return rows;
  } catch {
    positionsCache = { at: Date.now(), rows: null };
    return null;
  }
}

/* ---- working orders (fresh — protection checks) ---------------------- */

/** shared orders read: ALWAYS fresh (a stale stop list would blind the
 *  protection sweep). Failure returns null (callers keep waiting). */
export async function ctOrders(opts?: { fetchFn?: typeof fetch }): Promise<{ ok: boolean; orders: Record<string, unknown>[] }> {
  try {
    const res = await (opts?.fetchFn ?? fetch)(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(configuredAccount())}/orders`,
      {
        headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return { ok: false, orders: [] };
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (!j.success) return { ok: false, orders: [] };
    return { ok: true, orders: j.data ?? [] };
  } catch {
    return { ok: false, orders: [] };
  }
}

export function ctConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return enabled(env);
}

/* ---- orders history (30s — parentage for manual pairing) ------------- */

export type CtOrderHist = { id: string; parentId: string | null; action: string; ts: number };

let ordersHistCache: { at: number; rows: CtOrderHist[] | null } | null = null;
const ORDERS_HIST_TTL_MS = 30_000;

async function fetchOrdersHistRaw(fetchFn: typeof fetch): Promise<CtOrderHist[]> {
  const res = await fetchFn("https://app.crosstrade.io/v1/api/tv/orders?activeOnly=false", {
    headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`orders ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
  const out: CtOrderHist[] = [];
  for (const env of j.data ?? []) {
    for (const o of env.data ?? []) {
      const ts = Date.parse(String(o.timestamp ?? ""));
      if (!Number.isFinite(ts)) continue;
      out.push({
        id: String(o.id),
        parentId: o.parentId !== null && o.parentId !== undefined ? String(o.parentId) : null,
        action: String(o.action ?? "") === "Buy" ? "Buy" : "Sell",
        ts,
      });
    }
  }
  return out;
}

/** the session order list with parentage (child exit legs → parent entry
 *  order) — the same source scripts/reconcileTrades.ts uses. 30s cache;
 *  null on failure (callers fall back to chronological pairing). */
export async function ctOrdersHistory(opts?: { fetchFn?: typeof fetch }): Promise<CtOrderHist[] | null> {
  if (ordersHistCache && Date.now() - ordersHistCache.at < ORDERS_HIST_TTL_MS) return ordersHistCache.rows;
  try {
    const rows = await fetchOrdersHistRaw(opts?.fetchFn ?? fetch);
    ordersHistCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return ordersHistCache?.rows ?? null;
  }
}

/** TEST ONLY: reset the module caches. */
export function __resetCtAccountForTest() {
  snapCache = null;
  fillsCache = null;
  positionsCache = null;
  ordersHistCache = null;
}
