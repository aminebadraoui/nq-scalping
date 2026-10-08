/* ------------------------------------------------------------------ *
 * Neon read-through layer.
 *
 * When DATABASE_URL is set (Coolify env), the API serves the historical
 * data from Postgres instead of the local JSON files, so the deployed
 * dashboard does not need a data volume. The shapes returned here are
 * byte-for-byte what the file loaders return, so every analysis routine
 * downstream runs unchanged.
 * ------------------------------------------------------------------ */

import postgres from "postgres";
import type { Candle, LevelSheet, OHLCBar } from "./gcdata";

export function dbEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

let _sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!_sql) {
    const url = process.env.DATABASE_URL!;
    _sql = postgres(url, {
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : ("require" as const),
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return _sql;
}

/** epoch → "YYYY-MM-DDTHH:mm:00" in the feed's own wall clock (US Central).
 *  Only the date part and the HH:mm part are consumed downstream. */
function feedStamp(ts: Date): { day: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ts);
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { day: `${g.year}-${g.month}-${g.day}`, hhmm: `${g.hour}:${g.minute}` };
}

export async function dbListDatasets(): Promise<
  { date: string; sessions: ("RTH" | "ETH")[]; candles: Record<string, number> }[]
> {
  const rows = (await getDb().unsafe(
    "select date, session, candles from sessions order by date, session",
  )) as { date: Date; session: string; candles: number }[];
  const map = new Map<string, { sessions: ("RTH" | "ETH")[]; candles: Record<string, number> }>();
  for (const r of rows) {
    const day = new Date(r.date).toISOString().slice(0, 10);
    const e = map.get(day) ?? { sessions: [], candles: { RTH: 0, ETH: 0 } };
    if (!e.sessions.includes(r.session as "RTH" | "ETH")) e.sessions.push(r.session as "RTH" | "ETH");
    e.candles[r.session] = r.candles;
    map.set(day, e);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, sessions: v.sessions, candles: v.candles }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Rebuild the exact file shape: candles with per-tick bid×ask clusters.
 *  Requires BOTH bars and ticks: footprint_ticks are no longer written to
 *  Neon (2026-10-08 transfer-cap fix), so recent days have bars only —
 *  returning a candles-only day would silently strip the chart of its
 *  footprint. Return null so gcdata falls back to the R2/local archive,
 *  which always carries the full clusters. */
export async function dbLoadDay(date: string, session: "RTH" | "ETH"): Promise<Candle[] | null> {
  const sql = getDb();
  const bars = (await sql`
    select ts, h, l, v, buy, sell from candles_1m
    where date = ${date} and session = ${session}
    order by ts`) as { ts: Date; h: number; l: number; v: number; buy: number; sell: number }[];
  if (!bars.length) return null;

  const ticks = (await sql`
    select ts, price_cents, buy, sell, buy_trades, sell_trades
    from footprint_ticks
    where date = ${date} and session = ${session}
    order by ts`) as {
    ts: Date;
    price_cents: number;
    buy: number;
    sell: number;
    buy_trades: number;
    sell_trades: number;
  }[];
  if (!ticks.length) return null; // partial day — let the archive serve it

  // group clusters per minute. The postgres driver returns bigint columns as
  // STRINGS to preserve precision — everything here is cast to Number because
  // the imbalance engine does numeric comparisons and "9" >= 10 is true.
  const byMinute = new Map<number, Map<number, [number, number, number, number, number]>>();
  for (const tk of ticks) {
    const key = tk.ts.getTime();
    let m = byMinute.get(key);
    if (!m) byMinute.set(key, (m = new Map()));
    const buy = Number(tk.buy);
    const sell = Number(tk.sell);
    m.set(Number(tk.price_cents), [buy + sell, buy, sell, Number(tk.buy_trades), Number(tk.sell_trades)]);
  }

  return bars.map((b) => {
    const { day, hhmm } = feedStamp(b.ts);
    const levels: Record<string, [number, number, number, number, number]> = {};
    for (const [price, v] of byMinute.get(b.ts.getTime()) ?? []) levels[String(price)] = v;
    return {
      t: `${day}T${hhmm}:00-05:00`,
      high: Math.round(Number(b.h) * 100),
      low: Math.round(Number(b.l) * 100),
      total: Number(b.v),
      buy: Number(b.buy),
      sell: Number(b.sell),
      levels,
    };
  });
}

export async function dbLoadOhlc(date: string): Promise<Map<string, OHLCBar>> {
  const rows = (await getDb()`
    select ts, o, h, l, c, v from candles_1m
    where date = ${date} and o is not null and c is not null
    order by ts`) as { ts: Date; o: number; h: number; l: number; c: number; v: number }[];
  const out = new Map<string, OHLCBar>();
  for (const r of rows) {
    const key = feedStamp(r.ts).hhmm;
    out.set(key, { o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }
  return out;
}

/** Read the stored daily sheet (written by the ingester), if present. */
export async function dbLoadSheet(date: string): Promise<LevelSheet | null> {
  const rows = (await getDb()`
    select profile, payload from profile_sheets where date = ${date}`) as {
    profile: string;
    payload: Record<string, unknown>;
  }[];
  if (!rows.length) return null;
  const profiles: Record<string, never | null> = {};
  for (const r of rows) profiles[r.profile] = r.payload as never;
  // the ingester stores the six profile entries; naked POC and prev-day are
  // recomputed on demand by the normal code path
  return { asof: date, prevTradingDay: null, profiles, nakedPOCZone: null };
}
