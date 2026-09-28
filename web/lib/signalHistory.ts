/* ------------------------------------------------------------------ *
 * Signal history — the dashboard's record of every Telegram push.
 *
 * The always-on signal feed (lib/signalFeed.ts) pushes a trade card to
 * Telegram the moment the reversal sequence completes. That card was the
 * ONLY trace of the alert — nothing on the dashboard could show it. This
 * module closes the gap: every push is recorded as a structured entry,
 * kept in an in-memory ring buffer AND (when DATABASE_URL is set, e.g.
 * Coolify/Neon) persisted to Postgres so the history survives restarts
 * and spans days.
 *
 * Persistence is deliberately best-effort: a DB hiccup must never block
 * or fail a Telegram send, and must never crash the signal loop. The
 * in-memory buffer always holds the newest entries regardless.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";

export type SignalSide = "long" | "short" | "none";

export type SignalHistoryEntry = {
  /** process-generated unique id (also the DB dedupe key) */
  id: string;
  /** epoch ms when the push was recorded */
  ts: number;
  /** "HH:mm" New York */
  timeET: string;
  /** feed/session day (YYYY-MM-DD) */
  day: string;
  symbol: string;
  side: SignalSide;
  /** last price at the moment of the signal */
  price: number;
  /** the entry/trigger line from the trade ticket */
  entry: string;
  /** the stop/invalidation line */
  stop: string;
  /** the target line */
  target: string;
  /** the sizing line (contracts = risk ÷ (pts × $20)) */
  size: string;
  verdict: string;
  headline: string;
  source: string;
  /** true for a manual/forced push (POST /api/signal?push=1) vs automatic */
  test: boolean;
  /** whether Telegram accepted the message */
  sent: boolean;
  /** Telegram outcome ("sent" on success, or the failure reason) */
  reason: string;
};

const MAX_MEMORY = 200;
let seq = 0;
let tableReady = false;

/* Keep the buffer on globalThis (same pattern as the signal feed singleton) so
 * recording from instrumentation and reading from the API route share one list
 * even if Next.js instantiates this module in separate contexts. */
const g = globalThis as unknown as { __gcSignalHistory?: SignalHistoryEntry[] };
function getMemory(): SignalHistoryEntry[] {
  if (!g.__gcSignalHistory) g.__gcSignalHistory = [];
  return g.__gcSignalHistory;
}

const TABLE_SQL = `
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
  reason  text not null default ''
);
alter table signals add column if not exists size text not null default '';
create index if not exists signals_ts_idx on signals (ts desc);
`;

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

function newId(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${(++seq).toString(36)}-${rnd}`;
}

async function persist(e: SignalHistoryEntry): Promise<void> {
  if (!(await ensureTable())) return;
  try {
    await getDb()`
      insert into signals
        (key, ts, day, time_et, symbol, side, price, entry, stop, target, size, verdict, headline, source, test, sent, reason)
      values
        (${e.id}, ${e.ts}, ${e.day}, ${e.timeET}, ${e.symbol}, ${e.side}, ${e.price}, ${e.entry}, ${e.stop}, ${e.target}, ${e.size}, ${e.verdict}, ${e.headline}, ${e.source}, ${e.test}, ${e.sent}, ${e.reason})
      on conflict (key) do nothing`;
  } catch {
    /* best-effort — the in-memory buffer still holds the entry */
  }
}

export type SignalHistoryInput = Omit<SignalHistoryEntry, "id" | "ts" | "size"> & { ts?: number; size?: string };

/** Record a push. Adds to the in-memory buffer first (so it is visible even
 *  if the DB is down), then persists best-effort. Never throws. */
export async function recordSignal(input: SignalHistoryInput): Promise<SignalHistoryEntry> {
  const entry: SignalHistoryEntry = {
    id: newId(),
    ts: input.ts ?? Date.now(),
    timeET: input.timeET,
    day: input.day || new Date().toISOString().slice(0, 10),
    symbol: input.symbol,
    side: input.side,
    price: input.price,
    entry: input.entry,
    stop: input.stop,
    target: input.target,
    size: input.size ?? "—",
    verdict: input.verdict,
    headline: input.headline,
    source: input.source,
    test: input.test,
    sent: input.sent,
    reason: input.reason,
  };
  const mem = getMemory();
  mem.unshift(entry);
  if (mem.length > MAX_MEMORY) mem.length = MAX_MEMORY;
  await persist(entry);
  return entry;
}

/** In-process buffer only (no DB). Exposed for tests and as the always-on
 *  source of truth within the current process. */
export function getMemoryHistory(limit = 100): SignalHistoryEntry[] {
  return getMemory().slice(0, limit);
}

type DbRow = {
  key: string;
  ts: string;
  day: string;
  time_et: string;
  symbol: string;
  side: string;
  price: string;
  entry: string;
  stop: string;
  target: string;
  size: string;
  verdict: string;
  headline: string;
  source: string;
  test: boolean;
  sent: boolean;
  reason: string;
};

function mapDbRow(r: DbRow): SignalHistoryEntry {
  const side = r.side === "long" || r.side === "short" ? r.side : "none";
  return {
    id: r.key,
    ts: Number(r.ts),
    timeET: r.time_et,
    day: r.day,
    symbol: r.symbol,
    side: side as SignalSide,
    price: Number(r.price),
    entry: r.entry,
    stop: r.stop,
    target: r.target,
    size: r.size ?? "—",
    verdict: r.verdict,
    headline: r.headline,
    source: r.source,
    test: !!r.test,
    sent: !!r.sent,
    reason: r.reason,
  };
}

/**
 * The full history, most recent first: in-memory entries (newest, recorded
 * this process) merged with any older rows persisted by earlier processes.
 * Without DATABASE_URL this is just the in-memory buffer.
 */
export async function getSignalHistory(limit = 100): Promise<SignalHistoryEntry[]> {
  const mem = getMemory();
  const out: SignalHistoryEntry[] = [...mem];
  if (await ensureTable()) {
    try {
      const rows = (await getDb()`
        select key, ts, day, time_et, symbol, side, price, entry, stop, target, size, verdict, headline, source, test, sent, reason
        from signals order by ts desc limit ${limit}`) as unknown as DbRow[];
      const seen = new Set(mem.map((m) => m.id));
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
