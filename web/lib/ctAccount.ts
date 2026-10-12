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

/* ------------------------------------------------------------------ *
 * Shared CrossTrade REST transport (2026-10-12 — the broker_rate_limited
 * fix). The vendor paces ALL /v1/api/tv requests per Tradovate login:
 * when the login's request budget is spent, every endpoint answers
 * HTTP 429/503 or {"success":false,"error":"broker_rate_limited"}
 * instead of serving the read. On 2026-10-12 that killed the last two
 * RTH signals outright — the pre-flight flat check (GET positions) got a
 * pacing refusal and the gate failed the card instantly, with no retry.
 *
 * Vendor contract (docs: crosstrade.io/docs/api/rate-limiting):
 *   · CrossTrade budget 3 req/s (burst 20), shared REST + WS RPC;
 *     incoming WS frames are free; ~7s pause fully recharges.
 *   · broker_rate_limited is the Tradovate passthrough: p-ticket
 *     (endpoint hourly cap — early retries GROW the wait), the login's
 *     5,000 req/h user-level 429 (every request restarts the hour), or
 *     CrossTrade's own governor pacing (no penalty, flat hint).
 *   · Every refusal carries retryAfter in the body + Retry-After header.
 *     HONOR IT — blind fixed backoff can extend a broker penalty.
 *
 * ctFetch therefore:
 *   · spaces CrossTrade REST calls by CT_MIN_GAP_MS (no bursts),
 *   · retries pacing refusals, sleeping max(backoff, retryAfter) —
 *     bounded by retryAfterCapMs so one refusal can never stall a card,
 *   · after a refusal survives the retry budget, opens a PENALTY
 *     COOLDOWN: the poll helpers serve their last-known state without
 *     fetching until it clears (polls stop feeding a penalized login;
 *     critical reads — flat gate, place, verifyAbsent — still try),
 *   · never retries non-pacing responses — 400/401/403 come back
 *     instantly, exactly like the raw fetch they replace.
 *
 * Reads opt into 503 retries (a proxy hiccup on a GET is harmless to
 * repeat); WRITES (order place / cancel / re-arm / flatten) retry ONLY
 * on explicit pacing signals, never on a generic 503 — a 503 after
 * dispatch is ambiguous and a second POST could double a position.
 * ------------------------------------------------------------------ */

const CT_MIN_GAP_MS = 400;
let lastCtCallAt = 0;
/** TEST ONLY: override the production min-gap (0 in the default reset). */
let ctGapOverride: number | null = null;
/** TEST ONLY: override the default pacing backoff base. */
let ctBackoffOverride: number | null = null;

function ctGapMs(): number {
  return ctGapOverride ?? CT_MIN_GAP_MS;
}

/** which vendor pacing shape is this? (docs name three, plus the
 *  snapshot contention 429) */
export type CtRateLimitKind = "ct_pacing" | "broker" | "snapshot_pending";

export function classifyCtRateLimit(status: number, text: string): CtRateLimitKind | null {
  const t = text.slice(0, 500);
  if (t.includes("snapshot_refresh_pending")) return "snapshot_pending";
  if (t.includes("broker_rate_limited")) return "broker";
  if (status === 429) return "ct_pacing";
  return null;
}

/** is this response a pacing refusal at all (safe to retry a READ, and
 *  for writes the ONLY automatic retry)? */
export function isCtRateLimited(status: number, bodyText: string): boolean {
  return classifyCtRateLimit(status, bodyText) !== null;
}

/** the vendor's own wait hint: body `retryAfter` (seconds), then the
 *  Retry-After header (whole seconds per the docs). null when absent. */
export function parseRetryAfterMs(
  status: number,
  text: string,
  headers?: { get?: (k: string) => string | null } | null,
): number | null {
  const fromBody = /"retryAfter"\s*:\s*(\d+(?:\.\d+)?)/.exec(text)?.[1];
  if (fromBody !== undefined) {
    const n = Number(fromBody);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  const h = headers?.get?.("retry-after");
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  return null;
}

export type CtFetchOpts = {
  /** extra attempts after the first pacing refusal (default 2) */
  extraRetries?: number;
  /** base backoff for pacing retries (default 1200ms; ×2 per attempt, jittered) */
  backoffBaseMs?: number;
  /** retry on HTTP 503 as well (reads only — default false) */
  retryOn503?: boolean;
  /** cap on the retryAfter wait (default 15s) — a long broker penalty
   *  must fail the call, not stall a card */
  retryAfterCapMs?: number;
};

/** fetch one CrossTrade REST endpoint with pacing awareness. Returns the
 *  last status+body (a non-pacing response, or the final pacing refusal
 *  once the retry budget is spent — callers then fail closed as before).
 *  `fetchFn` is injectable for unit tests (defaults to global fetch). */
export async function ctFetch(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  opts?: CtFetchOpts,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; text: string }> {
  const extra = Math.max(0, opts?.extraRetries ?? 2);
  const backoffBase = opts?.backoffBaseMs ?? ctBackoffOverride ?? 1200;
  const retryOn503 = opts?.retryOn503 === true;
  const retryAfterCap = opts?.retryAfterCapMs ?? 15_000;
  let status = 0;
  let text = "";
  let lastKind: CtRateLimitKind | null = null;
  let lastRetryAfterMs: number | null = null;
  for (let attempt = 0; attempt <= extra; attempt++) {
    if (attempt > 0) {
      // honor the vendor's own wait hint when present — the docs are
      // explicit that early retries against a broker penalty grow it
      const base = backoffBase * 2 ** (attempt - 1) + Math.random() * 300;
      const wait =
        lastRetryAfterMs !== null ? Math.min(retryAfterCap, Math.max(base, lastRetryAfterMs)) : base;
      await sleep(wait);
    }
    // spacing: never let CrossTrade calls burst (pacing is per login and
    // our polls + a card's pre-flight can collide into a burst)
    const gapWait = Math.max(0, lastCtCallAt + ctGapMs() - Date.now());
    if (gapWait > 0) await sleep(gapWait);
    lastCtCallAt = Date.now();
    const res = await fetchFn(url, init);
    status = res.status;
    text = await readBody(res);
    const paced = isCtRateLimited(status, text) || (retryOn503 && status === 503);
    if (!paced) return { status, text };
    lastKind = classifyCtRateLimit(status, text);
    lastRetryAfterMs = parseRetryAfterMs(status, text, headersOf(res));
    console.warn(`[crossTrade] vendor pacing (HTTP ${status}${lastKind ? ` · ${lastKind}` : ""}) on ${url.split("/").pop()} — retry ${attempt + 1}/${extra}`);
  }
  // every attempt was paced — open the penalty cooldown so the polls
  // stop feeding the penalized login (critical reads still retry)
  if (lastKind) noteCtPenalty(lastKind, lastRetryAfterMs);
  return { status, text };
}

/** Response.headers with the test-mock shape tolerated. */
function headersOf(res: Response): { get?: (k: string) => string | null } | null {
  const h = (res as { headers?: unknown }).headers;
  if (h && typeof (h as { get?: unknown }).get === "function") {
    return h as { get: (k: string) => string | null };
  }
  return null;
}

/* ---- penalty cooldown (circuit breaker for the polls) -------------- */

const PENALTY_STALE_MAX_MS = 5 * 60_000;
let ctPenaltyUntil = 0;
let ctPenaltyKind: CtRateLimitKind | null = null;
/** TEST ONLY: override the penalty wait clamp. */
let ctPenaltyMinOverride: number | null = null;
let ctPenaltyMaxOverride: number | null = null;

/** is the penalty cooldown active? While active, the poll helpers serve
 *  their last-known state WITHOUT fetching — every request sent during a
 *  broker penalty restarts the login's hour clock (vendor docs). */
export function ctPenaltyActive(): boolean {
  return Date.now() < ctPenaltyUntil;
}

export function ctPenaltyInfo(): { kind: CtRateLimitKind | null; untilMs: number } {
  return { kind: ctPenaltyKind, untilMs: ctPenaltyUntil };
}

function noteCtPenalty(kind: CtRateLimitKind, retryAfterMs: number | null): void {
  // broker penalties are the Tradovate passthrough — a 30s floor lets a
  // spent login budget breathe (every request restarts its hour clock),
  // while CrossTrade's own pacing and the snapshot contention clear in
  // seconds. The window self-extends while the vendor keeps refusing.
  const min = ctPenaltyMinOverride ?? (kind === "broker" ? 30_000 : kind === "snapshot_pending" ? 5_000 : 8_000);
  const max = ctPenaltyMaxOverride ?? 300_000;
  const wait = Math.min(max, Math.max(min, retryAfterMs ?? min));
  ctPenaltyUntil = Math.max(ctPenaltyUntil, Date.now() + wait);
  ctPenaltyKind = kind;
  console.warn(`[crossTrade] penalty cooldown ${Math.round(wait / 1000)}s (${kind}) — polls serving cached state, critical reads may retry`);
}

function penaltyPaused(): boolean {
  return ctPenaltyActive();
}

/** read the body as text; json-only mocks (unit tests) fall back to their
 *  json() payload so ctFetch works with either Response shape. */
async function readBody(res: Response): Promise<string> {
  try {
    if (typeof res.text === "function") return await res.text();
  } catch {
    /* fall through to json */
  }
  try {
    if (typeof res.json === "function") return JSON.stringify(await res.json());
  } catch {
    /* empty body */
  }
  return "";
}

function ctKey(env: Record<string, string | undefined> = process.env): string {
  return (env.CROSSTRADE_KEY ?? "").trim();
}

export function configuredAccount(env: Record<string, string | undefined> = process.env): string {
  return (env.CROSSTRADE_ACCOUNT ?? "").trim();
}

function enabled(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.CROSSTRADE_URL && !!env.CROSSTRADE_KEY && !!env.CROSSTRADE_ACCOUNT;
}

/* ---- WebSocket mirror (order/position events, 2026-10-12) ---------- *
 * The vendor's own guidance: subscribe once and apply events by ID —
 * incoming frames are free, REST polling spends the shared budget. The
 * stream (lib/ctStream.ts) feeds this mirror; the poll helpers serve it
 * while it is fresh (frames within WS_FRESH_MS and hydrated by a REST
 * seed). On reconnect/resync the hydration flag resets, so the next read
 * re-seeds over REST exactly once — a stale mirror can never blind the
 * protection sweep, because freshness expires into the REST path.
 * -------------------------------------------------------------------- */

type CtWsMirror = {
  ordersHydratedAt: number;
  positionsHydratedAt: number;
  lastFrameAt: number;
  orders: Map<string, Record<string, unknown>>;
  positions: Map<string, Record<string, unknown>>;
};

let wsMirror: CtWsMirror = {
  ordersHydratedAt: 0,
  positionsHydratedAt: 0,
  lastFrameAt: 0,
  orders: new Map(),
  positions: new Map(),
};

const WS_FRESH_MS = 30_000;

/** the stream reconnected/resynced: the mirror is un-hydrated until the
 *  next REST read re-seeds it (replayed events are not complete). */
export function ctWsMarkResync(): void {
  wsMirror.ordersHydratedAt = 0;
  wsMirror.positionsHydratedAt = 0;
}

/** any WS frame keeps the mirror's liveness clock warm (pnl/status too). */
export function ctWsHeartbeat(): void {
  wsMirror.lastFrameAt = Date.now();
}

/** an orderUpdate/positionUpdate frame: upsert by id. Frames before the
 *  first hydration are ignored — a half-seeded mirror lies. */
export function ctApplyWsFrame(kind: "order" | "position", row: Record<string, unknown>): void {
  wsMirror.lastFrameAt = Date.now();
  const hydrated = kind === "order" ? wsMirror.ordersHydratedAt : wsMirror.positionsHydratedAt;
  if (hydrated === 0) return;
  const key = kind === "order" ? String(row.id ?? "") : String(row.id ?? row.positionId ?? "");
  if (!key) return;
  (kind === "order" ? wsMirror.orders : wsMirror.positions).set(key, row);
}

function wsMirrorFresh(kind: "order" | "position"): boolean {
  const hydrated = kind === "order" ? wsMirror.ordersHydratedAt : wsMirror.positionsHydratedAt;
  return hydrated > 0 && Date.now() - wsMirror.lastFrameAt < WS_FRESH_MS;
}

/* ---- account snapshot (30s) ---------------------------------------- */

async function fetchSnapshotRaw(fetchFn: typeof fetch): Promise<CtSnapshotAccount[]> {
  const res = await ctFetch(
    "https://app.crosstrade.io/v1/api/tv/accounts/snapshot",
    { headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) },
    { extraRetries: 1, retryOn503: true },
    fetchFn,
  );
  if (res.status < 200 || res.status >= 300) throw new Error(`snapshot ${res.status}`);
  const j = JSON.parse(res.text) as { accounts?: CtSnapshotAccount[] };
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
  // penalty cooldown: serve the last good snapshot up to 5 min old
  // (realized P&L only moves on fills — the guard's floor checks are
  // safe on it) and go silent on the wire so the vendor penalty clears;
  // no usable cache → fail closed exactly as before.
  if (penaltyPaused()) {
    if (snapCache?.accounts && Date.now() - snapCache.at <= PENALTY_STALE_MAX_MS) return snapCache;
    return { at: Date.now(), accounts: null };
  }
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
  const res = await ctFetch(
    "https://app.crosstrade.io/v1/api/tv/fills",
    { headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) },
    { extraRetries: 2, retryOn503: true },
    fetchFn,
  );
  if (res.status < 200 || res.status >= 300) throw new Error(`fills ${res.status}`);
  const j = JSON.parse(res.text) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
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
 *  returned (the watcher's fallback semantics), null when none exists.
 *  Penalty cooldown: serve the cache without fetching — fills polls must
 *  not feed a penalized login. */
export async function ctFills(opts?: { force?: boolean; fetchFn?: typeof fetch }): Promise<CtFill[] | null> {
  if (!opts?.force && fillsCache && Date.now() - fillsCache.at < FILLS_TTL_MS) return fillsCache.fills;
  if (penaltyPaused()) return fillsCache?.fills ?? null;
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
  const res = await ctFetch(
    `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(configuredAccount())}/positions`,
    {
      headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
    { extraRetries: 2, retryOn503: true },
    fetchFn,
  );
  if (res.status < 200 || res.status >= 300) throw new Error(`positions ${res.status}`);
  const j = JSON.parse(res.text) as { success?: boolean; data?: Array<Record<string, unknown>> };
  if (!j.success) throw new Error("positions read failed");
  return j.data ?? [];
}

/** shared positions read: WS-mirror first (frames are free), then the 2s
 *  cache, then REST (which re-seeds the mirror). Failure null-caches
 *  (unreadable). Penalty cooldown: serve the last known rows silently. */
export async function ctPositions(opts?: { fetchFn?: typeof fetch }): Promise<Record<string, unknown>[] | null> {
  if (wsMirrorFresh("position")) return [...wsMirror.positions.values()];
  if (positionsCache && Date.now() - positionsCache.at < POSITIONS_TTL_MS) return positionsCache.rows;
  if (penaltyPaused()) return positionsCache?.rows ?? null;
  try {
    const rows = await fetchPositionsRaw(opts?.fetchFn ?? fetch);
    positionsCache = { at: Date.now(), rows };
    // REST seed replaces the mirror — the position list is the whole truth
    wsMirror.positions = new Map(rows.map((r) => [String(r.id ?? r.positionId ?? ""), r]));
    wsMirror.positionsHydratedAt = Date.now();
    return rows;
  } catch {
    positionsCache = { at: Date.now(), rows: null };
    return null;
  }
}

/* ---- working orders (WS mirror → REST) ------------------------------ */

/** shared orders read. The WS mirror serves while fresh (order events
 *  update it in real time — fresher than any poll); REST re-seeds the
 *  mirror when the stream is silent or un-hydrated. Failure/unreadable
 *  returns ok=false (callers keep waiting — never guess a stop list).
 *  Penalty cooldown: ok=false without fetching. */
export async function ctOrders(opts?: { fetchFn?: typeof fetch }): Promise<{ ok: boolean; orders: Record<string, unknown>[] }> {
  if (wsMirrorFresh("order")) return { ok: true, orders: [...wsMirror.orders.values()] };
  if (penaltyPaused()) return { ok: false, orders: [] };
  try {
    const res = await ctFetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(configuredAccount())}/orders`,
      {
        headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
      { extraRetries: 2, retryOn503: true },
      opts?.fetchFn ?? fetch,
    );
    if (res.status < 200 || res.status >= 300) return { ok: false, orders: [] };
    const j = JSON.parse(res.text) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (!j.success) return { ok: false, orders: [] };
    const rows = j.data ?? [];
    // REST seed replaces the mirror (a working-order list is the whole truth)
    wsMirror.orders = new Map(rows.map((r) => [String(r.id ?? r.orderId ?? ""), r]));
    wsMirror.ordersHydratedAt = Date.now();
    return { ok: true, orders: rows };
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
  const res = await ctFetch(
    "https://app.crosstrade.io/v1/api/tv/orders?activeOnly=false",
    { headers: { Authorization: `Bearer ${ctKey()}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) },
    { extraRetries: 1, retryOn503: true },
    fetchFn,
  );
  if (res.status < 200 || res.status >= 300) throw new Error(`orders ${res.status}`);
  const j = JSON.parse(res.text) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
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
  if (penaltyPaused()) return ordersHistCache?.rows ?? null;
  try {
    const rows = await fetchOrdersHistRaw(opts?.fetchFn ?? fetch);
    ordersHistCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return ordersHistCache?.rows ?? null;
  }
}

/** TEST ONLY: reset the module caches + the transport pacing state. */
export function __resetCtAccountForTest(opts?: {
  gapMs?: number;
  backoffBaseMs?: number;
  penaltyMinMs?: number;
  penaltyMaxMs?: number;
}) {
  snapCache = null;
  fillsCache = null;
  positionsCache = null;
  ordersHistCache = null;
  lastCtCallAt = 0;
  ctGapOverride = opts?.gapMs ?? 0;
  ctBackoffOverride = opts?.backoffBaseMs ?? null;
  ctPenaltyMinOverride = opts?.penaltyMinMs ?? null;
  ctPenaltyMaxOverride = opts?.penaltyMaxMs ?? null;
  ctPenaltyUntil = 0;
  ctPenaltyKind = null;
  wsMirror = { ordersHydratedAt: 0, positionsHydratedAt: 0, lastFrameAt: 0, orders: new Map(), positions: new Map() };
}
