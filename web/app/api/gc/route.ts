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
import { getLive } from "@/lib/live";
import { crossTradeEnabled, mapInstrument } from "@/lib/crossTrade";
import {
  FEED_MOMENTUM,
  FEED_BIGBAR,
  FEED_RTH,
  FEED_OPEN,
  FEED_OPEN_DRIVE,
  FEED_OPEN_PULLBACK,
  FEED_OPEN_SNIPER,
  FEED_REVERSAL,
  FEED_SWEEP_RECLAIM,
  FEED_PULLBACK_TICKET,
  FEED_UNUSUAL_VOLUME,
  FEED_GAP_ALERTS,
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
          buildId: process.env.BUILD_SHA || "dev",
          sessions: sessionsInfo,
          hasDbUrl: !!process.env.DATABASE_URL,
          dbUrlHost: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null,
          dataDir: process.env.GC_DATA_DIR ?? null,
          execution: {
            crosstradeConfigured: crossTradeEnabled(),
            tradingHalt: (await import("@/lib/tradingHalt")).tradingHalted(),
            account: masked,
            instrument: mapInstrument(process.env.GOCHARTING_SYMBOL || "NQZ26", process.env.CROSSTRADE_INSTRUMENT),
            executeLive: process.env.EXECUTE_LIVE === "1",
            protections: await (async () => {
              try {
                const { guardState } = await import("@/lib/accountGuard");
                const { crossGuardSnapshot, crossGuardLiveSnapshot } = await import("@/lib/crossGuard");
                const { deriveExecStatus } = await import("@/lib/execStatus");
                const { daySizeMultiplier, parseSizeTiers, DEFAULT_SIZE_TIERS } = await import("@/lib/propRules");
                const s = guardState();
                const gbPct = Number(process.env.GUARD_GIVEBACK_PCT ?? "0.5");
                const gbFloor = Number(process.env.GUARD_GIVEBACK_FLOOR ?? "250");
                const limit = Math.max(gbFloor, gbPct * s.dayPeak);
                const tiers = process.env.SIZE_TIERS !== undefined ? parseSizeTiers(process.env.SIZE_TIERS) : DEFAULT_SIZE_TIERS;
                const dailyFloor = Number(process.env.DAILY_LOSS_FLOOR ?? "250");
                const profitArm = Number(process.env.PROFIT_ARM ?? "400");
                const ddHi = Number(process.env.DD_HALF_AT ?? "600");
                const ddLo = Number(process.env.DD_FULL_AT ?? "300");
                // display-only read: cached when the gate polled recently,
                // a fresh fetch otherwise (the gate itself still fetches
                // through crossGuardGate before every order)
                const snap = crossGuardSnapshot() ?? (await crossGuardLiveSnapshot());
                const margin = Number(process.env.MFF_GUARD_MARGIN ?? "500");
                const status = deriveExecStatus(
                  {
                    stage: s.stage,
                    startBalance: s.startBalance,
                    profitTarget: s.profitTarget,
                    floor: s.floor,
                    highWater: s.highWater,
                    locked: s.locked,
                    dayKey: s.dayKey,
                    dayPnl: Math.round(s.dayPnl),
                    dayPeak: Math.round(s.dayPeak),
                    consistencyCap: s.consistencyCap,
                    dailyFloor,
                    profitArm,
                    profitArmed: s.profitArmed,
                    lastDayPnl: s.lastDayPnl === null ? null : Math.round(s.lastDayPnl),
                    ddHi,
                    ddLo,
                    ddHalved: s.ddHalved,
                    dayBaselineOk: s.dayBaselineOk,
                    giveback: { armed: gbPct > 0, pct: gbPct, floor: gbFloor, haltAt: Math.round(s.dayPeak - limit) },
                  },
                  snap,
                  { executeLive: process.env.EXECUTE_LIVE === "1", crosstradeConfigured: crossTradeEnabled(), guardMargin: margin },
                );
                return {
                  status,
                  stage: s.stage,
                  startBalance: s.startBalance,
                  profitTarget: s.profitTarget,
                  floor: s.floor,
                  highWater: s.highWater,
                  locked: s.locked,
                  lastCommitDay: s.lastCommitDay,
                  dayKey: s.dayKey,
                  dayPnl: Math.round(s.dayPnl),
                  dayPeak: Math.round(s.dayPeak),
                  consistencyCap: s.consistencyCap,
                  dailyFloor,
                  profitArm,
                  profitArmed: s.profitArmed,
                  lastDayPnl: s.lastDayPnl === null ? null : Math.round(s.lastDayPnl),
                  dd: { hi: ddHi, lo: ddLo, halved: s.ddHalved },
                  giveback: {
                    armed: gbPct > 0,
                    pct: gbPct,
                    floor: gbFloor,
                    haltAt: Math.round(s.dayPeak - limit),
                  },
                  tier: daySizeMultiplier(s.dayPnl, tiers),
                  tiers,
                  account: snap,
                };
              } catch {
                return null;
              }
            })(),
            feeds: {
              momentum: FEED_MOMENTUM,
              bigbar: FEED_BIGBAR,
              rth: FEED_RTH,
              openDrive: FEED_OPEN_DRIVE,
              open: FEED_OPEN,
              openPullback: FEED_OPEN_PULLBACK,
              openSniper: FEED_OPEN_SNIPER,
              reversal: FEED_REVERSAL,
              sweepReclaim: FEED_SWEEP_RECLAIM,
              pullbackTicket: FEED_PULLBACK_TICKET,
              unusualVolume: FEED_UNUSUAL_VOLUME,
              gapAlerts: FEED_GAP_ALERTS,
            },
            // live-feed volume parity: accumulated per-minute buy+sell vs
            // the vendor's own day volume — the ratio shows whether the
            // tick feed undercounts prints (the open-drive absolute floors
            // starve silently if it does)
            liveFeed: await (async () => {
              try {
                const st = getLive().state;
                let acc = 0;
                let candleBars = 0;
                let tickBars = 0;
                for (const m of st.minutes) acc += m.buy + m.sell;
                for (const m of st.minutes.slice(-120)) {
                  if (m.source === "candle") candleBars++;
                  else tickBars++;
                }
                const snapVol = Number(st.snapshot?.volume ?? 0);
                const now = Date.now();
                return {
                  connected: st.connected,
                  minutes: st.minutes.length,
                  lastMessageMs: st.lastMessage ?? 0,
                  lastTradeAgeSec: st.lastTradeMs ? Math.round((now - st.lastTradeMs) / 1000) : null,
                  lastVolChangeAgeSec: st.lastVolChangeMs ? Math.round((now - st.lastVolChangeMs) / 1000) : null,
                  accumulatedVol: acc,
                  snapshotVol: snapVol,
                  ratio: snapVol > 0 ? +(acc / snapVol).toFixed(2) : null,
                  // bar-source mix over the last 120 bars: "candle" = the
                  // vendor footprint candles (what backtests use); "tick" =
                  // the lossy tick aggregate. Cards only fire on candle bars.
                  barSource: { candle: candleBars, tick: tickBars },
                  lastCandleRefreshAt: st.lastCandleRefreshAt ?? 0,
                  // confirm-race / fast-dispatch state (lib/live.ts): the
                  // REST-vs-frame confirmation race for the just-closed bar
                  confirmRace: st.race
                    ? {
                        fastDispatch: st.race.fastDispatch,
                        active: st.race.active,
                        races: st.race.races,
                        restWins: st.race.restWins,
                        frameWins: st.race.frameWins,
                        lastRestConfirmMs: st.race.lastRestConfirmMs,
                        lastFrameConfirmMs: st.race.lastFrameConfirmMs,
                      }
                    : null,
                  // tape-gap self-heal ladder (lib/live.ts): episode clock,
                  // current step, and the recovery actions taken so far
                  heal: st.heal ?? null,
                  // the family checkers' gate view (2026-10-15): the SAME
                  // tail/age/composed decision the signal path makes — a
                  // healthy feed must show veto:false (the post-deploy smoke
                  // script asserts exactly this)
                  tapeGate: (await import("@/lib/signalFeed")).tapeGateDiagnostics(st.minutes, now),
                  // the detectors' candidate counts on the live buffer —
                  // "the market has no setups" is a measured number
                  detectors: (await import("@/lib/signalFeed")).detectorScanDiagnostics(st.minutes),
                };
              } catch (e) {
                console.error("[health] liveFeed error:", e);
                return null;
              }
            })(),
            // DOM_V2 L2 feed health — frames/decoded/silent-connects so a
            // dead vendor channel is visible instead of a reconnect flap
            domFeed: await (async () => {
              try {
                const { getDom } = await import("@/lib/dom");
                const d = getDom().state;
                return {
                  connected: d.connected,
                  frames: d.frames,
                  silentConnects: d.silentConnects,
                  lastReconnectAt: d.lastReconnectAt ?? 0,
                  nqSnapshots: d.nq.snapshots,
                  nqIncrements: d.nq.increments,
                };
              } catch (e) {
                console.error("[health] domFeed error:", e);
                return null;
              }
            })(),
            // the rules board — EVERY live rule that can stop/restrict
            // trading today, with threshold, live metric, and state
            rules: await (async () => {
              try {
                const { guardState } = await import("@/lib/accountGuard");
                const { crossGuardSnapshot, crossGuardLiveSnapshot } = await import("@/lib/crossGuard");
                const { deriveRulesView } = await import("@/lib/execStatus");
                const { signalWindowOpen } = await import("@/lib/marketHours");
                const { newsBlockedNow } = await import("@/lib/newsGate");
                const { counterGateParams, recentWinnerCount } = await import("@/lib/rthExitLog");
                const { getSignalFeed } = await import("@/lib/signalFeed");
                const s = guardState();
                const snap = crossGuardSnapshot() ?? (await crossGuardLiveSnapshot());
                const now = Date.now();
                const liveSt = getLive().state;
                const gate = counterGateParams();
                const feed = getSignalFeed();
                // trailing unconfirmed bars on the live buffer (the tape gate)
                let tail = 0;
                for (let i = liveSt.minutes.length - 1; i >= 0; i--) {
                  if (liveSt.minutes[i].source === "candle") break;
                  tail++;
                }
                return deriveRulesView(
                  {
                    stage: s.stage,
                    startBalance: s.startBalance,
                    profitTarget: s.profitTarget,
                    floor: s.floor,
                    highWater: s.highWater,
                    locked: s.locked,
                    dayKey: s.dayKey,
                    dayPnl: s.dayPnl,
                    dayPeak: s.dayPeak,
                    consistencyCap: s.consistencyCap,
                    dailyFloor: Number(process.env.DAILY_LOSS_FLOOR ?? "250"),
                    profitArm: Number(process.env.PROFIT_ARM ?? "400"),
                    profitArmed: s.profitArmed,
                    lastDayPnl: s.lastDayPnl,
                    ddHi: Number(process.env.DD_HALF_AT ?? "600"),
                    ddLo: Number(process.env.DD_FULL_AT ?? "300"),
                    ddHalved: s.ddHalved,
                    dayBaselineOk: s.dayBaselineOk,
                    giveback: {
                      armed: Number(process.env.GUARD_GIVEBACK_PCT ?? "0.5") > 0,
                      pct: Number(process.env.GUARD_GIVEBACK_PCT ?? "0.5"),
                      floor: Number(process.env.GUARD_GIVEBACK_FLOOR ?? "250"),
                      haltAt: Math.round(s.dayPeak - Math.max(Number(process.env.GUARD_GIVEBACK_FLOOR ?? "250"), Number(process.env.GUARD_GIVEBACK_PCT ?? "0.5") * s.dayPeak)),
                    },
                  },
                  snap,
                  {
                    executeLive: process.env.EXECUTE_LIVE === "1",
                    crosstradeConfigured: !!process.env.CROSSTRADE_URL && !!process.env.CROSSTRADE_KEY && !!process.env.CROSSTRADE_ACCOUNT,
                    guardMargin: Number(process.env.MFF_GUARD_MARGIN ?? "500"),
                  },
                  {
                    windowOpen: signalWindowOpen(now),
                    windowLabel: "Sun 18:00 ET → Fri 16:00 ET · Mon–Thu 16:00–18:00 halt",
                    newsNow: newsBlockedNow(now),
                    newsNote: "all stages · funded adds a T1 ±3 min compliance ban",
                    tapeTail: tail,
                    tapeHolding: tail >= 1,
                    healStep: liveSt.heal?.step ?? 0,
                    healEpisodes: liveSt.heal?.episodes ?? 0,
                    rthCap: feed.rthCapStats(),
                    counterGate: {
                      enabled: gate.enabled,
                      min: gate.minMs / 60_000,
                      pts: gate.pts,
                      recentWinners: gate.enabled ? recentWinnerCount(now, gate.minMs) : 0,
                    },
                  },
                );
              } catch (e) {
                console.error("[health] rules error:", e);
                return null;
              }
            })(),
            // the health pipeline — every step of signal production →
            // execution in one payload (display-only reads of live state)
            pipeline: await (async () => {
              try {
                const { getSignalFeed } = await import("@/lib/signalFeed");
                const { latencySnapshot } = await import("@/lib/execLatency");
                const { execTradesMemory } = await import("@/lib/execTracker");
                const { signalWindowOpen } = await import("@/lib/marketHours");
                const now = Date.now();
                const feed = getSignalFeed();
                const snap = feed.lastSnapshot;
                const lat = latencySnapshot();
                const trades = execTradesMemory();
                const open = trades.filter((t) => t.status === "placed" || t.status === "filled");
                const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
                const today = trades.filter((t) => t.day === nyDay);
                const closed = today.filter((t) => t.status === "closed");
                const failed = trades.filter((t) => t.status === "failed");
                return {
                  windowOpen: signalWindowOpen(now),
                  signalCard: {
                    live: feed.liveOk,
                    lastRunMs: feed.lastRun,
                    lastError: feed.lastError,
                    lastNote: feed.lastNote,
                    lastSignal: snap
                      ? { timeET: snap.timeET, day: snap.day, side: snap.signal.side ?? "none", headline: snap.signal.headline }
                      : null,
                  },
                  latency: {
                    latest: lat.latest
                      ? {
                          totalMs: lat.latest.totalMs,
                          source: lat.latest.detail?.source ?? "",
                          barAgeMs: lat.latest.detail?.barAgeMs ?? null,
                          stages: { ...lat.latest.stages },
                        }
                      : null,
                    fills: lat.lastFills.slice(-5).map((f) => ({
                      ts: f.ts,
                      label: f.detail.label,
                      dir: f.detail.dir,
                      qty: f.detail.qty,
                      submitMs: f.detail.submitMs,
                      ackMs: f.detail.ackMs,
                      fillMs: f.detail.fillMs,
                      seenMs: f.detail.seenMs,
                    })),
                  },
                  execTrades: {
                    open: open.length,
                    wins: closed.filter((t) => t.result === "win").length,
                    losses: closed.filter((t) => t.result === "loss").length,
                    netUsd: Math.round(closed.reduce((s, t) => s + t.netUsd, 0) * 100) / 100,
                    failed: failed.length,
                    lastFailAt: failed.length ? Math.max(...failed.map((t) => t.ts)) : null,
                    // the ring is newest-first (upsertMemory unshifts)
                    last: trades[0]
                      ? {
                          ts: trades[0].ts,
                          label: trades[0].label,
                          status: trades[0].status,
                          result: trades[0].result,
                          netUsd: trades[0].netUsd,
                          fillEntryAt: trades[0].fillEntryAt,
                        }
                      : null,
                  },
                };
              } catch (e) {
                console.error("[health] pipeline error:", e);
                return null;
              }
            })(),
            // the calendar's view of the market — "open per calendar but no
            // prints arriving" is the dead-feed signature
            market: await (async () => {
              try {
                const { marketStatus } = await import("@/lib/marketHours");
                return marketStatus(Date.now());
              } catch (e) {
                console.error("[health] market error:", e);
                return null;
              }
            })(),
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
