/* ------------------------------------------------------------------ *
 * DOM evidence log — the iceberg observations behind the study.
 *
 * Two logs, both observational (nothing here can influence a signal):
 *
 * 1. dom_refills (Neon) — a rolling evidence table: one row per active
 *    iceberg candidate per heartbeat (60s while the level keeps its
 *    refill signature). Written by the live DOM feed on the VPS
 *    (LIVE_WRITE=true gate, like liveStore.ts — a localhost dev server
 *    must not double-write). This is the time series future studies
 *    join against signals/trades.
 *
 * 2. signals.features->>'dom' — the DOM context captured at the instant
 *    each signal was recorded (see domBook.buildDomContext +
 *    signalFeed.record): candidates + their distance to entry/stop/target.
 *
 * Best-effort by design: a dropped write is never retried, and a DB
 * blip must never break the live feed.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import type { IcebergCandidate } from "./domBook";

const TABLE_SQL = `
create table if not exists dom_refills (
  ts          bigint not null,
  day         text not null,
  symbol      text not null default 'NQ',
  side        text not null,
  price       numeric(10,2) not null,
  shown       integer not null default 0,
  absorbed    integer not null default 0,
  refills     integer not null default 0,
  slice       integer not null default 0,
  consistency numeric(4,3) not null default 0,
  confidence  numeric(4,3) not null default 0,
  peak        integer not null default 0
);
alter table dom_refills add column if not exists symbol text not null default 'NQ';
create index if not exists dom_refills_ts_idx on dom_refills (ts desc);
create index if not exists dom_refills_price_idx on dom_refills (price, ts desc);
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

/** Write one row per active candidate. Fire-and-forget from the feed. */
export async function persistDomRefills(symbol: "NQ" | "ES", rows: IcebergCandidate[]): Promise<void> {
  if (rows.length === 0) return;
  if (!dbEnabled() || process.env.LIVE_WRITE !== "true") return;
  if (!(await ensureTable())) return;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const values = rows.map((c) => ({
    ts: now,
    day,
    symbol,
    side: c.side,
    price: c.price.toFixed(2),
    shown: Math.round(c.size),
    absorbed: c.absorbed,
    refills: c.refills,
    slice: c.refillSize,
    consistency: c.refillConsistency.toFixed(3),
    confidence: c.confidence.toFixed(3),
    peak: c.peak,
  }));
  try {
    const sql = getDb();
    await sql`
      insert into dom_refills ${sql(values as never, "ts", "day", "symbol", "side", "price", "shown", "absorbed", "refills", "slice", "consistency", "confidence", "peak")}`;
  } catch {
    /* best-effort — evidence only */
  }
}
