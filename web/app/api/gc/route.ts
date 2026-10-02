import type { NextRequest } from "next/server";
import {
  listDatasets,
  computeSheet,
  computeProfile,
  extractFootprint,
  analyze,
  optionsSnapshot,
  type Session,
} from "@/lib/gcdata";
import { getOptionsFeed } from "@/lib/optionsFeed";
import { crossTradeEnabled, mapInstrument } from "@/lib/crossTrade";
import {
  FEED_MOMENTUM,
  FEED_RTH,
  FEED_OPEN,
  FEED_OPEN_DRIVE,
  FEED_OPEN_PULLBACK,
  FEED_OPEN_SNIPER,
  FEED_REVERSAL,
  FEED_SWEEP_RECLAIM,
  FEED_PULLBACK_TICKET,
} from "@/lib/signalFeed";

const SESSIONS: Session[] = ["RTH", "ETH"];

/* ------------------------------------------------------------------ *
 * In-process response cache. The collected data behind `analysis`,
 * `footprint` and `sheet` only changes when the nightly ingester runs,
 * yet the dashboard polls `analysis` every 60s and each call re-reads
 * the whole footprint table (~53k rows). Serving a 60s-fresh copy from
 * memory instead turns those polls into free cache hits — the single
 * biggest cut to Neon's network-transfer (egress) bill.
 * ------------------------------------------------------------------ */
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
const TTL_MS = 60_000;

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value as T);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      inflight.delete(key);
      return value;
    },
    (err) => {
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const action = url.searchParams.get("action") ?? "datasets";
  const date = url.searchParams.get("date");
  const session = url.searchParams.get("session") as Session | null;
  const start = url.searchParams.get("start") ?? undefined;
  const end = url.searchParams.get("end") ?? undefined;
  const row = Number(url.searchParams.get("row") ?? 4);

  try {
    switch (action) {
      case "health": {
        // deployment diagnostic: what THIS container sees
        let sessionsInfo: unknown = null;
        try {
          const { getDb, dbEnabled } = await import("@/lib/gcdb");
          if (dbEnabled()) {
            const rows = await getDb().unsafe("select date, session, candles from sessions order by date, session");
            sessionsInfo = { count: (rows as unknown[]).length, first: (rows as unknown[])[0] ?? null };
          } else {
            sessionsInfo = "no DATABASE_URL";
          }
        } catch (e) {
          sessionsInfo = { error: String(e) };
        }
        // the execution arm — what THIS container would do at the next signal
        const acct = process.env.CROSSTRADE_ACCOUNT ?? "";
        const masked = acct.length > 8 ? `${acct.slice(0, 4)}…${acct.slice(-4)}` : acct || null;
        return Response.json({
          ok: true,
          buildId: "readthrough-v3",
          sessions: sessionsInfo,
          hasDbUrl: !!process.env.DATABASE_URL,
          dbUrlHost: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null,
          dataDir: process.env.GC_DATA_DIR ?? null,
          execution: {
            crosstradeConfigured: crossTradeEnabled(),
            account: masked,
            instrument: mapInstrument(process.env.GOCHARTING_SYMBOL || "NQZ26", process.env.CROSSTRADE_INSTRUMENT),
            executeLive: process.env.EXECUTE_LIVE === "1",
            protections: await (async () => {
              try {
                const { guardState } = await import("@/lib/accountGuard");
                const { daySizeMultiplier, parseSizeTiers, DEFAULT_SIZE_TIERS } = await import("@/lib/propRules");
                const s = guardState();
                const gbPct = Number(process.env.GUARD_GIVEBACK_PCT ?? "0.5");
                const gbFloor = Number(process.env.GUARD_GIVEBACK_FLOOR ?? "250");
                const limit = Math.max(gbFloor, gbPct * s.dayPeak);
                const tiers = process.env.SIZE_TIERS !== undefined ? parseSizeTiers(process.env.SIZE_TIERS) : DEFAULT_SIZE_TIERS;
                return {
                  dayKey: s.dayKey,
                  dayPnl: Math.round(s.dayPnl),
                  dayPeak: Math.round(s.dayPeak),
                  giveback: {
                    armed: gbPct > 0,
                    pct: gbPct,
                    floor: gbFloor,
                    haltAt: Math.round(s.dayPeak - limit),
                  },
                  tier: daySizeMultiplier(s.dayPnl, tiers),
                  tiers,
                  consistencyCap: s.consistencyCap,
                };
              } catch {
                return null;
              }
            })(),
            feeds: {
              momentum: FEED_MOMENTUM,
              rth: FEED_RTH,
              openDrive: FEED_OPEN_DRIVE,
              open: FEED_OPEN,
              openPullback: FEED_OPEN_PULLBACK,
              openSniper: FEED_OPEN_SNIPER,
              reversal: FEED_REVERSAL,
              sweepReclaim: FEED_SWEEP_RECLAIM,
              pullbackTicket: FEED_PULLBACK_TICKET,
            },
          },
          now: new Date().toISOString(),
        });
      }
      case "datasets": {
        return Response.json({ datasets: await listDatasets() });
      }
      case "sheet": {
        if (!date) return Response.json({ error: "missing date" }, { status: 400 });
        return Response.json({ sheet: await cached(`sheet:${date}`, () => computeSheet(date)) });
      }
      case "profile": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const p = await cached(`profile:${date}:${session}:${start ?? ""}:${end ?? ""}:${row}`, () =>
          computeProfile(date, session, start, end, row),
        );
        if (!p) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(p);
      }
      case "footprint": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const f = await cached(`footprint:${date}:${session}:${start ?? ""}:${end ?? ""}`, () =>
          extractFootprint(date, session, start, end),
        );
        if (!f) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(f);
      }
      case "analysis": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const a = await cached(`analysis:${date}:${session}:${start ?? ""}:${end ?? ""}:${row}`, () =>
          analyze(date, session, start, end, row),
        );
        if (!a) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(a);
      }
      case "options": {
        const symbol = url.searchParams.get("symbol") ?? "QQQ";
        const feed = getOptionsFeed();
        const fresh = feed.snapshot();
        const g = fresh ?? (await optionsSnapshot(symbol));
        if (!g) return Response.json({ error: "no options data" }, { status: 404 });
        return Response.json({ ...g, refresh: feed.info() });
      }
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
