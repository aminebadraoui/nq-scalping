/* ------------------------------------------------------------------ *
 * Live write-through: persist each completed live minute into Neon as
 * it rolls over, so the current session survives any container restart
 * instead of living only in the LiveFeed's RAM buffer.
 *
 * Best-effort by design: a dropped write is not retried (the nightly
 * ingester is the authoritative writer and reconciles everything on its
 * next pass). The live rows are a preview — the ingester's post-close
 * data overwrites them via the same upsert keys.
 *
 * Writes the ETH (full Globex day) session only. RTH is a derived subset
 * that the nightly job computes; live minutes belong to the full day.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { utcToEpoch } from "./times";

export type LiveStoreMinute = {
  /** "HH:mm" in UTC (live ticks are keyed by the UTC minute). */
  t: string;
  /** UTC calendar date of the bar. */
  du?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  buy: number;
  sell: number;
  /** price (points, "30738.00") -> [buy volume, sell volume]. */
  levels?: Record<string, [number, number]>;
};

/**
 * The ETH session is keyed by the New York date it CLOSES on: 18:00 ET (and
 * later) belongs to the next calendar day, 16:59 ET and earlier to the same
 * day. Matches the file/ingest naming (`2026-09-25_ETH.json` holds 09-24
 * 18:00 → 09-25 16:59).
 */
export function sessionDateForUtc(hhmm: string, du: string): string {
  const sec = utcToEpoch(hhmm, du);
  if (!Number.isFinite(sec)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  const hour = Number(g.hour) % 24;
  const day = `${g.year}-${g.month}-${g.day}`;
  if (hour >= 18) {
    return new Date(Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day) + 1))
      .toISOString()
      .slice(0, 10);
  }
  return day;
}

export async function persistLiveMinute(m: LiveStoreMinute): Promise<void> {
  // only the designated live writer persists (the VPS runs LIVE_WRITE=true;
  // a localhost dev server also boots the feed and must not double-write)
  if (!dbEnabled() || process.env.LIVE_WRITE !== "true") return;
  const day = m.du ?? new Date().toISOString().slice(0, 10);
  const sec = utcToEpoch(m.t, day);
  if (!Number.isFinite(sec)) return;
  const ts = new Date(sec * 1000).toISOString();
  const date = sessionDateForUtc(m.t, day);
  if (!date) return;

  try {
    const sql = getDb();
    const o = m.o > 0 ? m.o.toFixed(2) : null;
    const c = m.c > 0 ? m.c.toFixed(2) : null;
    await sql`
      insert into candles_1m (ts, date, session, o, h, l, c, v, buy, sell)
      values (${ts}, ${date}, 'ETH', ${o}, ${m.h.toFixed(2)}, ${m.l.toFixed(2)}, ${c}, ${m.buy + m.sell}, ${m.buy}, ${m.sell})
      on conflict (ts, session) do update set
        date = excluded.date, o = excluded.o, h = excluded.h, l = excluded.l,
        c = excluded.c, v = excluded.v, buy = excluded.buy, sell = excluded.sell
    `;

    const ticks = Object.entries(m.levels ?? {}).map(([p, cell]) => ({
      ts,
      date,
      session: "ETH",
      price_cents: Math.round(Number(p) * 100),
      buy: cell[0],
      sell: cell[1],
      // live ticks carry volume, not per-price trade counts — the nightly
      // ingester fills the authoritative counts from FOOTPRINT/V2
      buy_trades: 0,
      sell_trades: 0,
    }));
    if (ticks.length) {
      await sql`
        insert into footprint_ticks ${sql(ticks as never, "ts", "date", "session", "price_cents", "buy", "sell", "buy_trades", "sell_trades")}
        on conflict (ts, session, price_cents) do update set
          date = excluded.date, buy = excluded.buy, sell = excluded.sell,
          buy_trades = excluded.buy_trades, sell_trades = excluded.sell_trades
      `;
    }
  } catch (e) {
    // best-effort — never let a DB blip kill the live feed
    console.error("liveStore persist failed:", (e as Error).message ?? e);
  }
}
