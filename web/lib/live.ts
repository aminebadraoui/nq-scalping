import { promises as fs } from "fs";
import path from "path";
import { decodeFootprintForDateResponse, splitFrame, type BootCandle } from "./footprintProto";
import { persistLiveMinute } from "./liveStore";
import { marketOpenAt } from "./marketHours";
import { sessionDayOf } from "./times";
import { esFrontMonth } from "./esJoin";
import { appendDaybook } from "./daybook";
import { sendTelegram } from "./notify";
import { getTvFeed, tvBarComplete, type TvBar, type TvBarBuilder, type TvFeed } from "./tvFeed";

/* ------------------------------------------------------------------ */
/* Live GoCharting feed (server-side singleton)                        */
/* Socket: wss://origin.ws.prodb.<dc>.gocharting.com/<dc>/ws           */
/* Personal use only — undocumented transport.                         */
/* ------------------------------------------------------------------ */

type Snapshot = {
  date: string;
  open: number;
  high: number;
  low: number;
  ltp: number;
  volume: number;
  prev_close: number;
  prev_date: string;
  s_type: string;
  delta: number;
};

export type Tick = {
  ms: number;
  ltp: number;
  size: number;
  side: 1 | -1;
};

export type LiveMinute = {
  t: string; // "HH:mm" UTC (ticks are keyed by UTC minute)
  /** UTC calendar date of this bar. Without it, reconstructing the instant
   *  after UTC midnight shifts every live bar a day forward. */
  du?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  buy: number;
  sell: number;
  live: boolean; // built from ticks vs bootstrapped
  /** where the bar came from: the vendor footprint candle (the archive's
   *  source — what every backtest was computed on) or the tick stream (a
   *  lossy ~7%-of-volume sample). Cards must only fire on "candle". */
  source?: "tick" | "candle";
  /** which vendor built the bar: GoCharting (default when absent) or
   *  Tradovate (lib/tvFeed.ts — the primary live feed since 2026-10-25).
   *  A closed, gap-free Tradovate bar is full-tape, so it carries
   *  source:"candle" and passes the same card gate. */
  vendor?: "gc" | "tv";
  /** price (0.25-tick) -> [buy, sell] contracts — only kept for the recent minutes */
  levels?: Record<string, [number, number]>;
  /** price (0.25-tick) -> [buyTrades, sellTrades] counts — parallel to
   *  levels; feeds the min_count_frac gate (fail-open when absent) */
  levelTrades?: Record<string, [number, number]>;
};

export type LiveState = {
  connected: boolean;
  lastMessage: number;
  /** last trade print (ms) and last vendor day-volume change (ms) — exposed
   *  so the health endpoint can distinguish a dead feed from a closed market */
  lastTradeMs: number;
  lastVolChangeMs: number;
  /** last successful candle refresh (ms; 0 = never) — the health endpoint
   *  reports it alongside the bar-source mix so a stalled refresh is visible */
  lastCandleRefreshAt: number;
  /** confirm-race bookkeeping (CONFIRM_RACE_PROBE measurement /
   *  FAST_DISPATCH production fast-confirm) — exposed via /health so the
   *  fast-confirm latency is a monitored number, not a hope. */
  race: {
    fastDispatch: boolean;
    active: boolean;
    races: number;
    restWins: number;
    frameWins: number;
    lastRestConfirmMs: number;
    lastFrameConfirmMs: number;
  };
  /** monotonic bar-buffer revision — bumped every time a candle merge
   *  REPLACES or ADDS a bar. The detector/ footprint caches key on this:
   *  a vendor revision of any mid-array bar invalidates them (the tick
   *  feed undercounts volume, so a replaced bar changes prefix math). */
  barsRevision: number;
  snapshot: Snapshot | null;
  ticks: Tick[];
  minutes: LiveMinute[];
  cur: LiveMinute | null;
  /** ES twin feed — the cross-asset context layer (BROAD CONFIRM / delta /
   *  RS-stretch chips). Same UTC minute keying as the NQ buffer; no ticks,
   *  no levels — the context only reads high/low/buy/sell per minute. */
  es: {
    lastTradeMs: number;
    minutes: LiveMinute[];
    cur: LiveMinute | null;
  };
  /** tape-gap self-heal ladder state (the live.ts recovery machine) */
  heal: TapeHealState;
  /** live source arbitration (Tradovate primary, GC hot standby) */
  feed?: FeedStatus;
};

/* ------------------------------------------------------------------ *
 * Tape-gap self-heal ladder (2026-10-06): when the vendor candle path
 * dies while ticks keep flowing (the "tape-gate gap" that pages the
 * operator), the feed heals ITSELF before asking a human:
 *   1. force a candle fetch with a FRESH Cognito token (a quietly dead
 *      cached token is a prime suspect for "fetch returned 0");
 *   2. force a WS reconnect + re-subscribe (re-seeds the FOOTPRINT/V2
 *      frame channel);
 *   3. soft re-seed: clear the buffer and re-bootstrap from the vendor's
 *      footprint history (the programmatic version of the manual
 *      "restart the container" advice).
 * The gate itself keeps holding throughout — this recovers the DATA
 * path, never fails the card gate open. Gated by marketOpenAt so the
 * daily 17:00–18:00 halt (no candles can complete) never trips it.
 * ------------------------------------------------------------------ */

export const TAPE_HEAL_TAIL_ALERT = 8; // same threshold as signalFeed's pager
export const TAPE_HEAL_FETCH_INTERVAL_MS = 60_000;
export const TAPE_HEAL_MAX_FORCED_FETCHES = 2;
export const TAPE_HEAL_STEP2_MS = 120_000; // two fetches failed → reconnect
export const TAPE_HEAL_STEP3_MS = 300_000; // reconnect didn't fix → re-seed

export type TapeHealState = {
  /** episode start (ms; 0 = no active stall) */
  sinceAt: number;
  /** 1 = forced fetches · 2 = forced reconnect · 3 = soft re-seed */
  step: 0 | 1 | 2 | 3;
  /** when the current step last acted */
  stepAt: number;
  forcedFetches: number;
  reconnects: number;
  reseeds: number;
  /** last episode end (ms; 0 = never healed) */
  healedAt: number;
  /** total episodes closed */
  episodes: number;
};

export function seedTapeHeal(): TapeHealState {
  return { sinceAt: 0, step: 0, stepAt: 0, forcedFetches: 0, reconnects: 0, reseeds: 0, healedAt: 0, episodes: 0 };
}

export type TapeHealAction = "none" | "force-fetch" | "force-reconnect" | "force-reseed";

/** Pure ladder decision (unit-tested): a stall = trailing unconfirmed tail
 *  ≥ TAPE_HEAL_TAIL_ALERT on a buffer that HAS seen candles (a fresh boot
 *  with an all-tick buffer is a seed-in-flight, not a stall). */
export function tapeHealDecision(
  h: TapeHealState,
  now: number,
  tail: number,
  total: number,
): { next: TapeHealState; action: TapeHealAction } {
  const stall = tail >= TAPE_HEAL_TAIL_ALERT && tail < total;
  if (!stall) {
    if (h.sinceAt !== 0) {
      return {
        next: { ...seedTapeHeal(), healedAt: now, episodes: h.episodes + 1 },
        action: "none",
      };
    }
    return { next: h, action: "none" };
  }
  let next = h;
  if (h.sinceAt === 0) {
    // new episode: reset the per-episode counters and step clock, but KEEP
    // `episodes` (the cumulative close count) and `healedAt` (last close).
    // The old code re-seeded here, which wiped episodes every time — every
    // close logged "episode 1" and the health counter could never grow.
    next = { ...h, sinceAt: now, step: 1, stepAt: 0, forcedFetches: 0, reconnects: 0, reseeds: 0 };
  }
  const episodeMs = now - next.sinceAt;
  const stepMs = now - next.stepAt;
  if (next.forcedFetches < TAPE_HEAL_MAX_FORCED_FETCHES && stepMs >= TAPE_HEAL_FETCH_INTERVAL_MS) {
    return {
      next: { ...next, step: 1, stepAt: now, forcedFetches: next.forcedFetches + 1 },
      action: "force-fetch",
    };
  }
  if (next.forcedFetches >= TAPE_HEAL_MAX_FORCED_FETCHES && next.reconnects < 1 && episodeMs >= TAPE_HEAL_STEP2_MS) {
    return { next: { ...next, step: 2, stepAt: now, reconnects: 1 }, action: "force-reconnect" };
  }
  if (next.reconnects >= 1 && next.reseeds < 1 && episodeMs >= TAPE_HEAL_STEP3_MS) {
    return { next: { ...next, step: 3, stepAt: now, reseeds: 1 }, action: "force-reseed" };
  }
  return { next, action: "none" };
}

const TICK = 0.25;

/** Full Globex day is 23 hours (1,380 minutes). The live buffer must hold a
 *  whole session so the 18:00 ET reopen candle survives until the nightly
 *  collection picks the session up. */
const MAX_MINUTES = 1380;

/** Cognito IdTokens live ~1h. Refresh before expiry so a reconnect never
 *  reuses a dead token (the old code fetched it once and never again). */
const TOKEN_REFRESH_MS = 50 * 60_000;

/* ------------------------------------------------------------------ *
 * Wall-clock helpers (America/New_York) for the bootstrap window.
 * ------------------------------------------------------------------ */

function nyParts(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow: p.weekday,
  };
}

/** "YYYY-MM-DD" for the New York calendar day `offsetDays` from today. */
function nyDate(offsetDays = 0): string {
  const p = nyParts();
  return new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays)).toISOString().slice(0, 10);
}

/** Globex hours: Sun 18:00 ET → Fri 17:00 ET, minus the daily 17:00–18:00 halt. */
function globexOpen(now = new Date()): boolean {
  return marketOpenAt(now.getTime());
}

/** close epoch (ms) of a completed LiveMinute from its UTC du+t stamps
 *  (the same convention signalFeed.barCloseMs uses; 0 when unparseable) */
function liveMinuteCloseMs(m: { t: string; du?: string }): number {
  if (!/^\d{2}:\d{2}$/.test(m.t) || !m.du) return 0;
  const [y, mo, d] = m.du.split("-").map(Number);
  const [hh, mm] = m.t.split(":").map(Number);
  const ms = Date.UTC(y, mo - 1, d, hh, mm) + 60_000;
  return Number.isFinite(ms) ? ms : 0;
}

/** bars-frozen watchdog (2026-10-15): the 2026-10-15 afternoon went blind
 *  for 6+ hours — the vendor candle pipeline froze at 09:34 ET and the
 *  tick frames carried stale timestamps, so NO bar completed. The heal
 *  ladder never saw it (its trigger is an unconfirmed TAIL, and the tail
 *  stayed at 1 while bars stopped completing). This detector keys on the
 *  tail bar's close age: while the market is open, a completed tail older
 *  than STALE_BARS_RECOVERY_MS means the bar-builder is frozen — feed the
 *  ladder a synthetic stall (fetch → reconnect → reseed) and page the
 *  operator. */
export const STALE_BARS_RECOVERY_MS = 3 * 60_000;

/** pure: the buffer's tail closed more than thresholdMs ago (0 = unparseable
 *  tail — never stale). */
export function tapeTailStale(minutes: Array<{ t: string; du?: string }>, now: number, thresholdMs: number = STALE_BARS_RECOVERY_MS): boolean {
  const last = minutes[minutes.length - 1];
  if (!last) return false; // empty buffer — seed in flight, never stale
  const close = liveMinuteCloseMs(last);
  return close > 0 && now - close > thresholdMs;
}

/** FAST_DISPATCH=1 — production fast-confirm (fill-lag fix, 2026-10-15):
 *  after each minute closes, race the vendor REST endpoint for the
 *  just-closed candle (~7.5 s observed by CONFIRM_RACE_PROBE) instead of
 *  waiting for the 32–57 s frame confirmation, so the limit-entry cards
 *  dispatch ~25–50 s earlier. Default 0 = today's behavior. The card
 *  gate still requires a candle-source bar, so a failed race can only
 *  hold cards, never fire them on thin data. */
export function fastDispatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FAST_DISPATCH === "1";
}

/** the confirm race runs in production (FAST_DISPATCH=1) or as the
 *  measurement probe (CONFIRM_RACE_PROBE=1 — timing logs only). */
export function confirmRaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return fastDispatchEnabled(env) || env.CONFIRM_RACE_PROBE === "1";
}

/** the race window: how long after a bar close we keep polling REST for
 *  the just-closed candle (polls every 1.5 s). 20 s since 2026-10-15 —
 *  the probe's ~7.5 s figure didn't hold live (8/8 races lost the 12 s
 *  window on day one); 20 s still beats the 32–57 s frame channel and
 *  degrades harmlessly when REST is slower. */
export const RACE_WINDOW_MS = 20_000;

/** pure: format a confirmation-race outcome line (unit-tested).
 *  restMs/frameMs = first-confirmed epoch per channel (0 = not confirmed). */
export function formatConfirmRace(key: string, closeMs: number, restMs: number, frameMs: number, now: number): string {
  if (restMs === 0 && frameMs === 0) {
    return `[confirm-race] bar ${key} — NEITHER confirmed within 20s (vendor lag; ${((now - closeMs) / 1000).toFixed(1)}s since close)`;
  }
  const winner = restMs > 0 && (frameMs === 0 || restMs <= frameMs) ? "REST" : "frame";
  const rest = restMs > 0 ? `REST+${((restMs - closeMs) / 1000).toFixed(1)}s` : "REST —";
  const frame = frameMs > 0 ? `frame+${((frameMs - closeMs) / 1000).toFixed(1)}s` : "frame —";
  return `[confirm-race] bar ${key} ${rest} · ${frame} → ${winner} wins`;
}

/**
 * One-shot fetch of the in-progress Globex session from FOOTPRINT/V2, over its
 * own socket so it can never disturb the live trade channel. Returns the raw
 * candles (feed-clock ISO timestamps + high/low/buy/sell in cents).
 */
function fetchFootprintBars(dates: string[], env: Record<string, string>, tokenOverride?: string): Promise<BootCandle[]> {
  return new Promise((resolve) => {
    const out: BootCandle[] = [];
    let ws: WebSocket | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    setTimeout(finish, 20_000); // no-op if finish already ran (settled guard)

    void (async () => {
      let token: string;
      try {
        token = tokenOverride ?? (await cognitoIdToken(env));
      } catch {
        return finish();
      }
      const dc = env.GOCHARTING_DC || "nyc1";
      const url = `wss://origin.ws.prodb.${dc}.gocharting.com/${dc}/ws?token=${token}&tag=${Date.now()}`;
      try {
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
      } catch {
        return finish();
      }
      ws.onopen = () => {
        let rid = 0;
        for (const d of dates) {
          ws!.send(
            JSON.stringify({
              request_id: ++rid,
              command: "FOOTPRINT/V2",
              payload: {
                exchange: env.GOCHARTING_EXCHANGE || "CME",
                segment: env.GOCHARTING_SEGMENT || "FUTURE",
                symbol: env.GOCHARTING_SYMBOL || "NQZ26",
                interval: "1m",
                dates: [d],
                session: "ETH",
              },
            }),
          );
        }
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string" || !(ev.data instanceof ArrayBuffer)) return;
        try {
          const f = splitFrame(new Uint8Array(ev.data));
          if (!f || !f.header.startsWith("FOOTPRINT/V2")) return;
          const r = decodeFootprintForDateResponse(f.body);
          for (const c of r.candles) out.push(c);
        } catch {
          /* malformed frame — ignore */
        }
      };
      ws.onclose = finish;
      ws.onerror = finish;
    })();
  });
}

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(process.cwd(), "..", "gcdata", ".env");
  try {
    const raw = require("fs").readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const [k, ...rest] = s.split("=");
      out[k.trim()] = rest.join("=").trim();
    }
  } catch {
    /* no env file */
  }
  for (const k of ["GOCHARTING_EMAIL", "GOCHARTING_PASSWORD", "GOCHARTING_COGNITO_CLIENT", "GOCHARTING_DC", "GOCHARTING_SYMBOL", "GOCHARTING_EXCHANGE", "GOCHARTING_SEGMENT", "FAST_DISPATCH", "CONFIRM_RACE_PROBE"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

async function cognitoIdToken(env: Record<string, string>): Promise<string> {
  const body = {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: env.GOCHARTING_COGNITO_CLIENT,
    AuthParameters: { USERNAME: env.GOCHARTING_EMAIL, PASSWORD: env.GOCHARTING_PASSWORD },
  };
  const res = await fetch("https://cognito-idp.ap-south-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as any;
  return j.AuthenticationResult.IdToken;
}

/* ------------------------------------------------------------------ *
 * Live source arbitration (2026-10-25): Tradovate is the PRIMARY live
 * feed, GoCharting the hot standby. GC keeps its socket, candle
 * refresh and heal ladder running at all times (the `gc` buffer); the
 * public `state` serves Tradovate bars/ticks/quote while Tradovate is
 * healthy and falls back to GC the moment it is not. NQ and the ES
 * twin arbitrate independently. LIVE_BAR_SOURCE=gc forces GC
 * (kill switch); anything else = auto.
 * ------------------------------------------------------------------ */

export type FeedSource = "tv" | "gc";

/** Tradovate considered stale when no tick line arrived for this long
 *  while the market is open */
export const TV_STALE_MS = 20_000;
/** no closed bar for this long while open → unhealthy (NQ/ES trade every
 *  minute; two quiet minutes in a row means the chart stream died) */
export const TV_NO_BAR_MS = 125_000;
/** continuous health required before switching (back) to Tradovate */
export const TV_RECOVER_MS = 120_000;

export type FeedArbiter = {
  active: FeedSource;
  /** start of the current continuous-healthy streak (0 = unhealthy) */
  healthySince: number;
  lastSwitchAt: number;
  switches: number;
  /** why the current source is active (health reason on a fail-over) */
  reason: string;
};

export type FeedStatus = {
  forced: boolean;
  nq: FeedArbiter & { health: string };
  es: FeedArbiter & { health: string };
  tv: { sessionDay: string; nqSym: string | null; esSym: string | null; lastLineWallMs: number; ignoredSyms: string[] };
};

export function seedArbiter(): FeedArbiter {
  return { active: "gc", healthySince: 0, lastSwitchAt: 0, switches: 0, reason: "boot" };
}

export function liveBarSourceForced(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LIVE_BAR_SOURCE ?? "").trim().toLowerCase() === "gc";
}

/** Pure Tradovate health check for one builder. "ok" = usable now. */
export function tvHealth(
  b: Pick<TvBarBuilder, "lastTickWallMs" | "lastClosed" | "coverageStart">,
  now: number,
  bootstrapped: boolean,
): string {
  if (!bootstrapped) return "bootstrapping";
  if (!b.lastTickWallMs) return "no ticks";
  if (now - b.lastTickWallMs > TV_STALE_MS) return `stale ${Math.round((now - b.lastTickWallMs) / 1000)}s`;
  if (!b.coverageStart()) return "warming (no complete bar yet)";
  const lc = b.lastClosed();
  if (!lc) return "no closed bar";
  if (now - (lc.ms + 60_000) > TV_NO_BAR_MS) return `no bar since ${lc.t}Z`;
  if (!tvBarComplete(lc)) return lc.partial ? `partial bar ${lc.t}Z` : `gap ${lc.missing} ticks in ${lc.t}Z`;
  return "ok";
}

/** Pure arbiter transition. Fail over to GC immediately on any
 *  unhealthy reading while the market is open; return to Tradovate only
 *  after TV_RECOVER_MS of continuous health. A closed market holds the
 *  current source (no flapping across the daily halt). */
export function arbiterStep(prev: FeedArbiter, health: string, now: number, marketOpen: boolean, forced: boolean): FeedArbiter {
  if (forced) {
    if (prev.active === "gc" && prev.reason === "forced (LIVE_BAR_SOURCE=gc)") return prev;
    return { ...prev, active: "gc", healthySince: 0, lastSwitchAt: prev.active === "gc" ? prev.lastSwitchAt : now, switches: prev.active === "gc" ? prev.switches : prev.switches + 1, reason: "forced (LIVE_BAR_SOURCE=gc)" };
  }
  if (!marketOpen) return prev.healthySince ? { ...prev, healthySince: 0 } : prev;
  const ok = health === "ok";
  if (!ok) {
    if (prev.active === "tv") return { active: "gc", healthySince: 0, lastSwitchAt: now, switches: prev.switches + 1, reason: `tradovate ${health}` };
    return prev.healthySince ? { ...prev, healthySince: 0 } : prev;
  }
  const since = prev.healthySince || now;
  if (prev.active === "gc" && now - since >= TV_RECOVER_MS) {
    return { active: "tv", healthySince: since, lastSwitchAt: now, switches: prev.switches + 1, reason: "tradovate healthy" };
  }
  return since === prev.healthySince ? prev : { ...prev, healthySince: since };
}

function barKey(m: { du?: string; t: string }): string {
  return `${m.du ?? ""}|${m.t}`;
}

/** Pure: the served minute list in Tradovate mode. Complete Tradovate
 *  bars win; GC bars fill history before Tradovate coverage (and any
 *  incomplete Tradovate minute); GC bars NEWER than the last closed
 *  Tradovate bar are dropped (GC's tick-built just-rolled minute must
 *  not sit at the tail during the finalize grace). */
export function composeTvMinutes(gcMinutes: LiveMinute[], tvClosed: TvBar[]): LiveMinute[] {
  if (!tvClosed.length) return gcMinutes.slice();
  const lastTv = barKey(tvClosed[tvClosed.length - 1]);
  const byKey = new Map<string, LiveMinute>();
  for (const m of gcMinutes) {
    if (!/^\d{2}:\d{2}$/.test(m.t)) continue;
    const k = barKey(m);
    if (k > lastTv) continue;
    byKey.set(k, m);
  }
  for (const b of tvClosed) {
    const k = barKey(b);
    if (b.source === "candle" || !byKey.has(k)) byKey.set(k, b);
  }
  const out = [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1]);
  return out.length > MAX_MINUTES ? out.slice(-MAX_MINUTES) : out;
}

class LiveFeed {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private tokenFetchedAt = 0;
  private env: Record<string, string>;
  private listeners = new Set<(s: LiveState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLtp = 0;
  private lastEsLtp = 0;
  private retryMs = 10_000;
  private bootstrapped = false;
  private bootstrapAttemptAt = 0;
  /** staleness detection: the trade channel can go quiet while snapshots keep
   *  flowing (seen ~1h after connect — the 1-hour IdToken lifetime). If the
   *  market is demonstrably trading but no print arrives, force a reconnect
   *  with a fresh token + subscriptions. */
  private lastVol = -1;
  private lastForcedReconnectMs = 0;
  /** the Globex session day the buffer currently belongs to — crossing it
   *  (18:00 ET rollover) clears the buffer and re-subscribes */
  private lastSessionDay = "";
  /** rolling candle-refresh throttle (attempt clock — health reports the
   *  SUCCESS clock separately via state.lastCandleRefreshAt) */
  private candleRefreshAttemptAt = 0;
  private candleRefreshing = false;
  /** CONFIRM_RACE_PROBE bookkeeping — one bounded race at a time */
  private raceActive = false;
  private raceBarKey = "";
  private raceCloseMs = 0;
  private raceRestMs = 0;
  private raceFrameMs = 0;
  private raceFetchFailedLogged = false;
  /** per-minute throttle for the FOOTPRINT/V2 frame-path diagnostic line */
  private candleFrameLoggedAt = 0;
  /** last healed-episode timestamp already logged (dedup for the heal log) */
  private healLoggedAt = 0;
  /** bars-frozen watchdog (2026-10-15): log + operator page throttles */
  private frozenLoggedAt = 0;
  private frozenPageAt = 0;
  /** boot-grace gate: the last tail close seen + when it last advanced —
   *  the frozen page requires a tail that advanced and then stalled */
  private lastTailClose = 0;
  private tailAdvancedAt = 0;

  private tickTail(): number {
    let n = 0;
    for (let i = this.gc.minutes.length - 1; i >= 0; i--) {
      if ((this.gc.minutes[i].source ?? "tick") === "candle") break;
      n++;
    }
    return n;
  }

  /** Replace the completed tick-built bars with the vendor footprint
   *  candles every 60s (the same feed the archive is built from). The tick
   *  stream holds ~7% of true volume — cards must never evaluate it.
   *  Fire-and-forget; a failed fetch leaves bars tick-built and the
   *  candle-source card gate simply holds. `force` (the self-heal ladder)
   *  bypasses the throttle AND the cached token — a quietly dead token is
   *  a prime suspect for "fetch returned 0". */
  private refreshCandles(force = false) {
    const now = Date.now();
    if (this.candleRefreshing) return;
    if (!force && now - this.candleRefreshAttemptAt < 60_000) return;
    this.candleRefreshAttemptAt = now;
    this.candleRefreshing = true;
    // reuse the cached IdToken — a fresh Cognito auth on every refresh cycle
    // is what tripped the vendor's password-attempt lockout before (forced
    // fetches are rare: max 2 per stall episode)
    const tokenP =
      this.token && !force && now - this.tokenFetchedAt < TOKEN_REFRESH_MS
        ? Promise.resolve(this.token)
        : cognitoIdToken(this.env)
            .then((t) => {
              this.token = t;
              this.tokenFetchedAt = now;
              return t;
            })
            .catch(() => null as string | null);
    void tokenP
      .then((token) => (token ? fetchFootprintBars([nyDate(0), nyDate(1)], this.env, token) : Promise.resolve([])))
      .then((candles) => {
        if (!candles.length) {
          console.log("[candles] refresh: fetch returned 0 candles (token/socket issue?)");
          return;
        }
        const nowKey = new Date().toISOString().slice(0, 16).replace("T", "|");
        const r = mergeCandleMinutes(this.gc.minutes, candles, nowKey);
        if (r.replaced || r.added) this.gc.barsRevision++;
        this.gc.lastCandleRefreshAt = Date.now();
        const newest = candles.map((c) => c.t).sort().at(-1) ?? "";
        console.log(
          `[candles] refresh: ${candles.length} candles (newest ${newest}) · merged ${r.replaced}R/${r.added}A · tail ${this.tickTail()} tick`,
        );
        if (r.replaced || r.added) this.emit();
      })
      .catch((e) => {
        console.log("[candles] refresh failed:", (e as Error)?.message ?? e);
      })
      .finally(() => {
        this.candleRefreshing = false;
      });
  }

  /** CONFIRM_RACE_PROBE=1 — measure whether the vendor's REST endpoint
   *  publishes a just-closed candle faster than their own FOOTPRINT/V2
   *  frames (~7.5s observed). After each bar completes, while the tail is
   *  tick-source, poll the REST fetch every 1.5s for ≤RACE_WINDOW_MS
   *  (20s — the 2026-10-15 widening: the probe's ~7.5s observation did
   *  not hold live, 8/8 races lost the 12s window on day one; 20s still
   *  beats the 32–57s frame channel when REST wins, and loses harmlessly
   *  when it doesn't) (reusing the
   *  cached token — no new Cognito auths) and merge through the same
   *  idempotent mergeCandleMinutes path the frames use. Read-only probe:
   *  the card gate still requires a candle-source bar — this only
   *  measures, and when REST wins it confirms through the SAME vendor
   *  data the gate demands. One [confirm-race] log line per bar. */
  private startConfirmRace(bar: LiveMinute): void {
    if (!confirmRaceEnabled(this.env)) return;
    if (this.raceActive) return;
    if ((bar.source ?? "tick") === "candle") return; // already confirmed
    if (!this.token) return; // no cached token — the 60s refresh owns recovery
    const closeMs = liveMinuteCloseMs(bar);
    if (!closeMs) return;
    const key = `${bar.du}|${bar.t}`;
    this.raceActive = true;
    this.raceBarKey = key;
    this.raceCloseMs = closeMs;
    this.raceRestMs = 0;
    this.raceFrameMs = 0;
    this.raceFetchFailedLogged = false;
    this.gc.race.active = true;
    this.gc.race.races++;
    const step = (): void => {
      if (!this.raceActive || this.raceBarKey !== key) return;
      const now = Date.now();
      if (this.raceRestMs > 0 || this.raceFrameMs > 0 || now >= closeMs + RACE_WINDOW_MS || !marketOpenAt(now)) {
        this.finishConfirmRace(key);
        return;
      }
      void fetchFootprintBars([nyDate(0), nyDate(1)], this.env, this.token ?? undefined)
        .then((candles) => {
          if (!this.raceActive || this.raceBarKey !== key) return;
          if (!candles.length) return;
          const r = mergeCandleMinutes(this.gc.minutes, candles, new Date().toISOString().slice(0, 16).replace("T", "|"));
          if (r.replaced || r.added) {
            this.gc.barsRevision++;
            this.emit();
          }
          // the raced bar is the buffer tail for the whole race window (bars
          // are 60s apart); match on SOURCE like the tape gate does — the
          // vendor candle's day stamp uses the feed clock, not UTC, so a
          // du/t key match would miss the confirmation
          const confirmed = (this.gc.minutes.at(-1)?.source ?? "tick") === "candle";
          if (confirmed && this.raceRestMs === 0) {
            this.raceRestMs = Date.now();
            this.gc.race.restWins++;
            this.gc.race.lastRestConfirmMs = this.raceRestMs;
            if (fastDispatchEnabled(this.env)) {
              console.log(`[fast-dispatch] bar ${key} candle confirmed via REST +${((this.raceRestMs - closeMs) / 1000).toFixed(1)}s — cards eligible`);
            }
            this.finishConfirmRace(key);
          }
        })
        .catch((e) => {
          // probe — silent by default; one line per race when the fetch
          // itself fails (distinguishes "REST has no candle yet" from
          // "REST unreachable" in the race log)
          if (!this.raceFetchFailedLogged) {
            this.raceFetchFailedLogged = true;
            console.log(`[confirm-race] bar ${key} REST fetch failed: ${(e as Error)?.message ?? e}`);
          }
        });
      setTimeout(step, 1500);
    };
    setTimeout(step, 1500);
  }

  /** record a frame-side confirmation for the active race (socket path) */
  private noteRaceFrameConfirm(): void {
    if (!this.raceActive || this.raceFrameMs > 0) return;
    // same source-based match as the REST path (see above)
    const confirmed = (this.gc.minutes.at(-1)?.source ?? "tick") === "candle";
    if (!confirmed) return;
    this.raceFrameMs = Date.now();
    this.gc.race.frameWins++;
    this.gc.race.lastFrameConfirmMs = this.raceFrameMs;
    this.finishConfirmRace(this.raceBarKey);
  }

  private finishConfirmRace(key: string): void {
    if (!this.raceActive || this.raceBarKey !== key) return;
    if (process.env.CONFIRM_RACE_PROBE === "1") {
      console.log(formatConfirmRace(key, this.raceCloseMs, this.raceRestMs, this.raceFrameMs, Date.now()));
    }
    this.raceActive = false;
    this.gc.race.active = false;
  }

  gc: LiveState = {
    connected: false,
    lastMessage: 0,
    lastTradeMs: 0,
    lastVolChangeMs: 0,
    lastCandleRefreshAt: 0,
    race: { fastDispatch: false, active: false, races: 0, restWins: 0, frameWins: 0, lastRestConfirmMs: 0, lastFrameConfirmMs: 0 },
    snapshot: null,
    ticks: [],
    minutes: [],
    cur: null,
    barsRevision: 0,
    es: { lastTradeMs: 0, minutes: [], cur: null },
    heal: seedTapeHeal(),
  };

  /* ---- Tradovate-primary arbitration (see the block above the class) ---- */
  private tv: TvFeed | null = null;
  private nqArb: FeedArbiter = seedArbiter();
  private esArb: FeedArbiter = seedArbiter();
  private nqHealth = "not started";
  private esHealth = "not started";
  private pubKey = "";
  private pubRev = 0;
  private pubMinutes: LiveMinute[] = [];
  private pubEsMinutes: LiveMinute[] = [];
  private lastGcMinutes: LiveMinute[] | null = null;
  private lastGcEsMinutes: LiveMinute[] | null = null;
  private switchPagedAt = 0;

  /** The PUBLIC live state every consumer reads. With LIVE_BAR_SOURCE=gc
   *  it is the raw GC buffer (identity preserved). Otherwise a composed
   *  view: Tradovate bars/ticks/quote while Tradovate is healthy, GC
   *  otherwise — NQ and ES independently. barsRevision is a monotonic
   *  PUBLISHED revision: it bumps on any change of either vendor's bars
   *  or of the active source, so detector caches never serve a bar set
   *  from the other vendor. */
  get state(): LiveState {
    const gc = this.gc;
    if (liveBarSourceForced() || !this.tv) return gc;
    const tv = this.tv;
    const nqTv = this.nqArb.active === "tv";
    const esTv = this.esArb.active === "tv";
    const key = [nqTv, esTv, gc.barsRevision, gc.minutes.length, gc.es.minutes.length, tv.nq.revision, tv.es.revision].join("|");
    if (key !== this.pubKey || gc.minutes !== this.lastGcMinutes || gc.es.minutes !== this.lastGcEsMinutes) {
      this.pubKey = key;
      this.lastGcMinutes = gc.minutes;
      this.lastGcEsMinutes = gc.es.minutes;
      this.pubMinutes = nqTv ? composeTvMinutes(gc.minutes, tv.nq.closedBars()) : gc.minutes;
      this.pubEsMinutes = esTv ? composeTvMinutes(gc.es.minutes, tv.es.closedBars()) : gc.es.minutes;
      this.pubRev++;
    }
    const out: LiveState = {
      ...gc,
      barsRevision: this.pubRev,
      minutes: this.pubMinutes,
      es: esTv ? { lastTradeMs: tv.es.lastTickWallMs, minutes: this.pubEsMinutes, cur: tv.es.developing() } : gc.es,
      feed: this.feedStatus(),
    };
    if (nqTv) {
      out.connected = true;
      out.lastMessage = Math.max(tv.status.lastLineWallMs, gc.lastMessage);
      out.lastTradeMs = tv.nq.lastTickWallMs;
      out.lastVolChangeMs = tv.nq.lastTickWallMs;
      out.lastCandleRefreshAt = tv.nq.lastFinalizeAt;
      out.ticks = tv.nq.ticks;
      out.cur = tv.nq.developing();
      out.snapshot = this.tvSnapshot();
    }
    return out;
  }

  /** NQ day snapshot from the Tradovate quote; GC's fields fill gaps */
  private tvSnapshot(): Snapshot | null {
    const tv = this.tv!;
    const q = tv.nqQuote;
    const g = this.gc.snapshot;
    const ltp = tv.nq.lastPrice || q?.ltp || g?.ltp || 0;
    if (!ltp) return g;
    return {
      date: q?.timestamp ?? g?.date ?? new Date().toISOString(),
      open: q?.open ?? g?.open ?? ltp,
      high: q?.high ?? g?.high ?? ltp,
      low: q?.low ?? g?.low ?? ltp,
      ltp,
      volume: q?.volume ?? g?.volume ?? 0,
      prev_close: q?.settle ?? g?.prev_close ?? 0,
      prev_date: g?.prev_date ?? "",
      s_type: g?.s_type ?? "live",
      delta: tv.nq.delta(),
    };
  }

  private feedStatus(): FeedStatus {
    const st = this.tv?.status;
    return {
      forced: liveBarSourceForced(),
      nq: { ...this.nqArb, health: this.nqHealth },
      es: { ...this.esArb, health: this.esHealth },
      tv: {
        sessionDay: st?.sessionDay ?? "",
        nqSym: st?.nqSym ?? null,
        esSym: st?.esSym ?? null,
        lastLineWallMs: st?.lastLineWallMs ?? 0,
        ignoredSyms: st?.ignoredSyms ?? [],
      },
    };
  }

  /** 1s arbitration tick: health → transition → log/page/journal */
  private arbitrate(now = Date.now()): void {
    const tv = this.tv;
    if (!tv) return;
    const forced = liveBarSourceForced();
    const open = marketOpenAt(now);
    this.nqHealth = tvHealth(tv.nq, now, tv.status.bootstrapped);
    this.esHealth = tvHealth(tv.es, now, tv.status.bootstrapped);
    const nq = arbiterStep(this.nqArb, this.nqHealth, now, open, forced);
    const es = arbiterStep(this.esArb, this.esHealth, now, open, forced);
    const nqSwitched = nq.active !== this.nqArb.active;
    const esSwitched = es.active !== this.esArb.active;
    this.nqArb = nq;
    this.esArb = es;
    if (!nqSwitched && !esSwitched) return;
    for (const [name, sw, a] of [["NQ", nqSwitched, nq], ["ES", esSwitched, es]] as const) {
      if (!sw) continue;
      console.log(`[feed] ${name} live source → ${a.active.toUpperCase()} (${a.reason}) · switch #${a.switches}`);
      try {
        appendDaybook({ t: "feed", at: now, sym: name, active: a.active, reason: a.reason, switches: a.switches });
      } catch {
        /* journaling is best-effort */
      }
    }
    this.emit();
    // page on NQ switches only (ES is context), at most every 2 min
    if (nqSwitched && now - this.switchPagedAt >= 120_000) {
      this.switchPagedAt = now;
      const toGc = nq.active === "gc";
      void sendTelegram(
        [
          toGc ? `⚠️ <b>LIVE FEED → GoCharting</b> (Tradovate fail-over)` : `✅ <b>LIVE FEED → Tradovate</b>`,
          `<code>${new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</code>`,
          `Reason: ${nq.reason}`,
        ].join("\n"),
        { parseMode: "HTML" },
      ).catch(() => {});
    }
  }

  constructor() {
    this.env = loadEnv();
    this.gc.race.fastDispatch = fastDispatchEnabled(this.env);
  }

  subscribe(fn: (s: LiveState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const s = this.state;
    for (const fn of this.listeners) fn(s);
  }

  /** Seed the in-progress session's history (fetched from FOOTPRINT/V2) so the
   *  18:00 ET reopen candle survives a restart. Candles arrive in the feed
   *  clock; they are re-keyed to the UTC wall clock every other live bar uses,
   *  so the existing blend + chart treat them like ordinary live minutes.
   *  The still-developing current minute is left to live ticks. */
  private seedFromFootprint(candles: BootCandle[]) {
    // NOTE: the now-key uses the SAME "|" separator as the buffer keys —
    // comparing "YYYY-MM-DD|HH:mm" against the ISO "T" form made every
    // current-day candle sort AFTER now, so the seed silently skipped the
    // whole in-progress session (the live buffer was tick-only — the 7%-of-
    // volume tape behind the 2026-10-05 live-vs-backtest divergence).
    const nowKey = new Date().toISOString().slice(0, 16).replace("T", "|"); // "YYYY-MM-DD|HH:mm" UTC
    const have = new Set(this.gc.minutes.map((m) => `${m.du ?? ""}|${m.t}`));
    // the developing minute (still `cur`, not yet in `minutes`) must win over a
    // seeded candle for the same minute, or it gets duplicated on rollover
    const cur = this.gc.cur;
    if (cur && /^\d{2}:\d{2}$/.test(cur.t)) have.add(`${cur.du ?? ""}|${cur.t}`);
    let added = 0;
    for (const c of candles) {
      const ms = Date.parse(c.t);
      if (!Number.isFinite(ms)) continue;
      const iso = new Date(ms).toISOString();
      const du = iso.slice(0, 10);
      const hhmm = iso.slice(11, 16);
      const key = `${du}|${hhmm}`;
      if (key >= nowKey) continue; // developing minute — live ticks own it
      if (have.has(key)) continue;
      // footprint candles with no price range (high/low = 0) carry no bar —
      // seeding them drags the chart's autoscale to 0 and blanks every real
      // candle, so drop them instead
      if (!(c.high > 0) || !(c.low > 0)) continue;
      have.add(key);
      this.gc.minutes.push({
        t: hhmm,
        du,
        o: 0, // footprint has no open/close — chart falls back to range bars
        h: c.high / 100,
        l: c.low / 100,
        c: 0,
        vol: c.buy + c.sell,
        buy: c.buy,
        sell: c.sell,
        live: true,
        source: "candle",
      });
      added++;
    }
    if (!added) return;
    this.gc.minutes.sort((a, b) => `${a.du ?? ""}|${a.t}`.localeCompare(`${b.du ?? ""}|${b.t}`));
    if (this.gc.minutes.length > MAX_MINUTES) this.gc.minutes = this.gc.minutes.slice(-MAX_MINUTES);
  }

  /** ES twin of seedFromFootprint: seed the in-progress session's ES minutes
   *  so the cross-asset context has the whole session, not just the bars
   *  since this process started. No persist, no levels. */
  private seedEsFromFootprint(candles: BootCandle[]) {
    const nowKey = new Date().toISOString().slice(0, 16).replace("T", "|");
    const buf = this.gc.es;
    const have = new Set(buf.minutes.map((m) => `${m.du ?? ""}|${m.t}`));
    const cur = buf.cur;
    if (cur && /^\d{2}:\d{2}$/.test(cur.t)) have.add(`${cur.du ?? ""}|${cur.t}`);
    let added = 0;
    for (const c of candles) {
      const ms = Date.parse(c.t);
      if (!Number.isFinite(ms)) continue;
      const iso = new Date(ms).toISOString();
      const du = iso.slice(0, 10);
      const hhmm = iso.slice(11, 16);
      const key = `${du}|${hhmm}`;
      if (key >= nowKey) continue; // developing minute — live ticks own it
      if (have.has(key)) continue;
      if (!(c.high > 0) || !(c.low > 0)) continue;
      have.add(key);
      buf.minutes.push({ t: hhmm, du, o: 0, h: c.high / 100, l: c.low / 100, c: 0, vol: c.buy + c.sell, buy: c.buy, sell: c.sell, live: true, source: "candle" });
      added++;
    }
    if (!added) return;
    buf.minutes.sort((a, b) => `${a.du ?? ""}|${a.t}`.localeCompare(`${b.du ?? ""}|${b.t}`));
    if (buf.minutes.length > MAX_MINUTES) buf.minutes = buf.minutes.slice(-MAX_MINUTES);
  }

  /** One-time recovery of the current session so far (idempotent, throttled). */
  private async bootstrap() {
    if (this.bootstrapped || !globexOpen()) return;
    const now = Date.now();
    if (now - this.bootstrapAttemptAt < 30_000) return;
    this.bootstrapAttemptAt = now;
    try {
      const candles = await fetchFootprintBars([nyDate(0), nyDate(1)], this.env);
      if (candles.length) {
        this.seedFromFootprint(candles);
        this.bootstrapped = true;
        this.emit();
      }
      // ES twin: fetch the same window under the ES front month and seed the
      // cross-asset buffer (best-effort — the NQ seed is what gates the flag)
      void fetchFootprintBars([nyDate(0), nyDate(1)], { ...this.env, GOCHARTING_SYMBOL: this.esSymbol() })
        .then((esCandles) => {
          if (esCandles.length) {
            this.seedEsFromFootprint(esCandles);
            this.emit();
          }
        })
        .catch(() => {});
    } catch {
      /* retry on a later tick */
    }
  }

  /** ES front-month symbol: GOCHARTING_ES_SYMBOL env override, else the
   *  H/M/U/Z 3rd-Friday calendar (esFrontMonth). */
  private esSymbol(): string {
    return process.env.GOCHARTING_ES_SYMBOL || esFrontMonth();
  }

  private nqSymbol(): string {
    return this.env.GOCHARTING_SYMBOL || "NQZ26";
  }

  /** (re)assert the channel subscriptions — the server can silently drop a
   *  subscription while the socket stays up (observed: snapshots kept flowing
   *  but the trade channel went quiet, so live bars froze). Both NQ and its
   *  ES twin are subscribed; trades are routed by payload key. */
  private subscribeChannels() {
    try {
      const base = `${this.env.GOCHARTING_EXCHANGE || "CME"}:${this.env.GOCHARTING_SEGMENT || "FUTURE"}`;
      const syms = [`${base}:${this.nqSymbol()}`, `${base}:${this.esSymbol()}`];
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "trade", payload: syms }));
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "watchlist", payload: syms }));
    } catch {
      /* ignore */
    }
  }

  private minuteKey(ms: number) {
    const d = new Date(ms);
    return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  /** minute-building core shared by the NQ and ES buffers: roll the current
   *  minute when the UTC key advances, accumulate h/l/c/vol/buy/sell and the
   *  per-price cluster. Returns true when a minute rolled. Persisting + tick
   *  bookkeeping live in the wrappers. */
  private applyTickTo(t: Tick, buf: { minutes: LiveMinute[]; cur: LiveMinute | null }): boolean {
    const key = this.minuteKey(t.ms);
    const hhmm = key.slice(11, 16);
    let cur = buf.cur;
    let rolled = false;
    if (!cur || cur.t !== hhmm) {
      if (cur) buf.minutes.push(cur);
      rolled = true;
      if (buf.minutes.length > MAX_MINUTES) buf.minutes = buf.minutes.slice(-MAX_MINUTES);
      // levels are only meaningful for the recent window — drop the rest
      for (let i = 0; i < buf.minutes.length - 30; i++) {
        delete buf.minutes[i].levels;
        delete buf.minutes[i].levelTrades;
      }
      cur = { t: hhmm, du: key.slice(0, 10), o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, vol: 0, buy: 0, sell: 0, live: true, source: "tick" };
      buf.cur = cur;
    }
    cur.h = Math.max(cur.h, t.ltp);
    cur.l = Math.min(cur.l, t.ltp);
    cur.c = t.ltp;
    cur.vol += t.size;
    if (t.side === 1) cur.buy += t.size;
    else cur.sell += t.size;
    // per-price cluster so the live bar has a real footprint (bid x ask per tick)
    const px = Math.round(t.ltp / TICK) * TICK;
    const pxKey = px.toFixed(2);
    const lv = (cur.levels ??= {});
    const cell = lv[pxKey] ?? [0, 0];
    cell[t.side === 1 ? 0 : 1] += t.size;
    lv[pxKey] = cell;
    // per-level trade counts (each tick = one trade) — the min_count_frac gate input
    const lt = (cur.levelTrades ??= {});
    const tcell = lt[pxKey] ?? [0, 0];
    tcell[t.side === 1 ? 0 : 1] += 1;
    lt[pxKey] = tcell;
    return rolled;
  }

  private applyTick(t: Tick) {
    const rolled = this.applyTickTo(t, this.gc);
    if (rolled) {
      // the minute just closed — persist it to Neon so live data survives a
      // restart instead of living only in this RAM buffer (best-effort)
      const prev = this.gc.minutes[this.gc.minutes.length - 1];
      if (prev && /^\d{2}:\d{2}$/.test(prev.t)) {
        void persistLiveMinute(prev).catch(() => {});
        this.startConfirmRace(prev);
      }
    }
    this.gc.ticks.push(t);
    if (this.gc.ticks.length > 2000) this.gc.ticks = this.gc.ticks.slice(-2000);
  }

  /** ES twin tick — same minute building, none of the NQ bookkeeping. */
  private applyEsTick(t: Tick) {
    this.applyTickTo(t, this.gc.es);
    this.gc.es.lastTradeMs = Date.now();
  }

  /** key ends with ":<symbol>" — matches the vendor's "CME:FUTURE:ESZ26"
   *  subscription keys (also tolerates a bare symbol). */
  private keyIs(key: unknown, sym: string): boolean {
    if (typeof key !== "string") return false;
    const k = key.toUpperCase();
    return k === sym.toUpperCase() || k.endsWith(`:${sym.toUpperCase()}`);
  }

  /** parse one symbol's trade prints and feed them to the right buffer */
  private applyTradeItems(items: any[], isEs: boolean) {
    for (const d of items) {
      const ltp = Number(d.ltp ?? d.price ?? d.last_price ?? d.last);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      // the trade channel carries the print size as `l_sz` (confirmed from the
      // 2026-09-28 session capture) — sizing every tick as 1 contract by
      // default would silently corrupt live volume and delta
      const size = Number(d.l_sz ?? d.quantity ?? d.qty ?? d.size ?? d.volume ?? d.last_qty ?? d.vol ?? 1);
      let side: 1 | -1 | null = null;
      if (typeof d.side === "number") side = d.side >= 0 ? 1 : -1;
      else if (typeof d.side === "string") side = d.side.toLowerCase().startsWith("b") ? 1 : -1;
      else if (typeof d.aggressor_side === "string") side = d.aggressor_side.toLowerCase().startsWith("b") ? 1 : -1;
      else if (typeof d.buy !== "undefined") side = d.buy ? 1 : -1;
      else if (isEs) side = ltp >= this.lastEsLtp ? 1 : -1; // ES twin is labels-only — the guess stays
      // update the last-price reference before any early-out so the ES guess
      // never compares against a stale print
      if (isEs) this.lastEsLtp = ltp;
      else this.lastLtp = ltp;
      if (side === null) continue; // NQ: never guess a side — tick-direction guesses corrupt buy/sell
      const tick: Tick = { ms: Date.parse(d.date ?? d.date_str ?? d.time ?? "") || Date.now(), ltp, size, side };
      if (isEs) this.applyEsTick(tick);
      else this.applyTick(tick);
    }
  }

  private handleText(msg: string) {
    if (msg.startsWith("PING-")) {
      this.ws?.send("PONG-" + msg.slice(5));
      return;
    }
    let j: any;
    try {
      j = JSON.parse(msg);
    } catch {
      return;
    }
    this.gc.lastMessage = Date.now();
    if (j.channel === "snapshot" && j.payload) {
      // with the ES twin subscribed the snapshot map carries both symbols —
      // pick the NQ entry, never ES
      let p: any = null;
      for (const [k, v] of Object.entries(j.payload as Record<string, unknown>)) {
        if (this.keyIs(k, this.nqSymbol())) {
          p = v;
          break;
        }
      }
      if (!p) p = Object.values(j.payload)[0] as any;
      if (p) {
        this.gc.snapshot = {
          date: p.date,
          open: p.open,
          high: p.high,
          low: p.low,
          ltp: p.ltp,
          volume: p.volume,
          prev_close: p.prev_close,
          prev_date: p.prev_date,
          s_type: p.s_type,
          delta: p.derived_values?.delta ?? 0,
        };
        // a moving day volume proves the market is trading (used to distinguish
        // a dropped subscription from a closed market)
        if (p.volume !== this.lastVol) {
          this.lastVol = p.volume;
          this.gc.lastVolChangeMs = Date.now();
        }
        // keep the current minute's last price honest even without ticks
        if (!this.gc.cur) {
          this.gc.cur = { t: "now", o: p.ltp, h: p.high, l: p.low, c: p.ltp, vol: 0, buy: 0, sell: 0, live: true };
        }
        this.emit();
      }
    } else if (j.channel === "trade" && j.payload) {
      this.gc.lastTradeMs = Date.now();
      // route each subscribed symbol's prints to its own buffer
      for (const [k, v] of Object.entries(j.payload as Record<string, unknown>)) {
        const p = v as any;
        const items = Array.isArray(p) ? p : p?.items ?? p?.data ?? [];
        if (!items.length) continue;
        this.applyTradeItems(items, this.keyIs(k, this.esSymbol()));
      }
      this.emit();
    } else if (j.channel === "watchlist" || j.channel === "positions" || j.channel === "chain") {
      // best-effort: same shape as trade
      const p = Object.values(j.payload || {})[0] as any;
      if (Array.isArray(p) && p.length && p[0].ltp) {
        const d = p[p.length - 1];
        this.lastLtp = Number(d.ltp);
        this.gc.lastMessage = Date.now();
      }
    }
  }

  async connect() {
    try {
      // IdTokens expire after ~1h. Refresh before that so a reconnect never
      // retries forever with a dead token (the old code fetched once and then
      // kept reusing the stale token until the process restarted).
      if (!this.token || Date.now() - this.tokenFetchedAt > TOKEN_REFRESH_MS) {
        this.token = await cognitoIdToken(this.env);
        this.tokenFetchedAt = Date.now();
      }
      const dc = this.env.GOCHARTING_DC || "nyc1";
      const url = `wss://origin.ws.prodb.${dc}.gocharting.com/${dc}/ws?token=${this.token}&tag=${Date.now()}`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.retryMs = 10_000; // healthy connect — reset the backoff
        this.gc.connected = true;
        this.emit();
        this.subscribeChannels();
      };
      this.ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.handleText(ev.data);
        else if (ev.data instanceof ArrayBuffer) {
          try {
            const fr = splitFrame(new Uint8Array(ev.data));
            if (fr && fr.header.startsWith("FOOTPRINT/V2")) {
              // live-developing footprint frames carry the vendor's candles
              // (the archive's source) as minutes complete — decode and merge
              // them so the just-closed bar is candle-confirmed in real time
              // (the rolling refresh is the recovery path when frames stop).
              const r = decodeFootprintForDateResponse(fr.body);
              if (r.candles.length) {
                // symbol guard: the socket is subscribed to NQ + the ES twin;
                // an ES footprint frame must never pollute the NQ buffer.
                const sym = r.symbol ? r.symbol.toUpperCase() : "";
                const nq = this.nqSymbol().toUpperCase();
                const ltp = this.gc.snapshot?.ltp ?? 0;
                const lastHigh = r.candles[r.candles.length - 1]?.high ?? 0;
                const pricePlausible = ltp > 0 && lastHigh > 0 ? Math.abs(lastHigh / 100 - ltp) / ltp < 0.2 : sym === nq;
                if ((!sym || sym === nq) && pricePlausible) {
                  const nowKey = new Date().toISOString().slice(0, 16).replace("T", "|");
                  const merged = mergeCandleMinutes(this.gc.minutes, r.candles, nowKey);
                  this.gc.lastCandleRefreshAt = Date.now();
                  if (merged.replaced || merged.added) {
                    this.gc.barsRevision++;
                    this.emit();
                  }
                  this.noteRaceFrameConfirm();
                  // one diagnostic line per minute max — the frame path is
                  // the real-time confirmation channel; its silence (or a
                  // growing tail) is the tape-gap signature
                  const now = Date.now();
                  if (now - this.candleFrameLoggedAt >= 60_000) {
                    this.candleFrameLoggedAt = now;
                    const newest = r.candles.map((c) => c.t).sort().at(-1) ?? "";
                    console.log(
                      `[candles] frame: ${r.candles.length} candles (newest ${newest}) · merged ${merged.replaced}R/${merged.added}A · tail ${this.tickTail()} tick`,
                    );
                  }
                }
              }
            }
            this.gc.lastMessage = Date.now();
          } catch {
            /* ignore */
          }
        }
      };
      this.ws.onclose = () => {
        this.gc.connected = false;
        this.emit();
        // exponential backoff: a tight reconnect loop is what got the account
        // temporarily locked by Cognito ("Password attempts exceeded")
        this.retryMs = Math.min(120_000, Math.max(10_000, (this.retryMs ?? 10_000) * 2));
        setTimeout(() => this.connect(), this.retryMs);
      };
      this.ws.onerror = () => {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      // 4xx (e.g. lockout) must not be retried fast — back off hard
      this.retryMs = Math.min(300_000, Math.max(60_000, (this.retryMs ?? 60_000) * 2));
      setTimeout(() => this.connect(), this.retryMs);
    }
  }

  start() {
    if (this.timer) return;
    this.connect();
    // Tradovate primary feed: tail the collector journal and arbitrate
    // every second (GC keeps running underneath as the hot standby)
    this.tv = getTvFeed();
    this.tv.onUpdate(() => this.emit());
    setInterval(() => this.arbitrate(), 1000);
    this.lastSessionDay = sessionDayOf(Date.now());
    let ticks = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      // ---- session rollover (18:00 ET): the data streams die at the
      //      boundary and do not come back on their own (observed: a fresh
      //      connect after the rollover received heartbeats but zero prints
      //      and a frozen day volume). Clear the old session's buffer, force
      //      a full reconnect + re-subscribe, and re-seed from footprint. ----
      const sessionDay = sessionDayOf(now);
      if (this.lastSessionDay && sessionDay !== this.lastSessionDay) {
        console.log(`[live] session rollover ${this.lastSessionDay} → ${sessionDay} — clearing buffer, reconnecting`);
        this.gc.minutes = [];
        this.gc.cur = null;
        this.gc.ticks = [];
        this.gc.es.minutes = [];
        this.gc.es.cur = null;
        this.bootstrapped = false;
        this.lastSessionDay = sessionDay;
        try {
          this.ws?.close(); // onclose → backoff reconnect → subscribeChannels
        } catch {
          /* ignore */
        }
      }
      if (this.gc.connected) {
        this.ws?.send(JSON.stringify({ command: "PING", payload: {} }));
        ticks++;
        // re-assert the subscriptions once a minute: cheap, and it recovers a
        // silently dropped trade channel without waiting for a reconnect
        if (ticks % 12 === 0) this.subscribeChannels();
        // watchdog 1: no message at all for 5 minutes while "connected" means
        // the socket is dead but silent — force a reconnect
        const dead = this.gc.lastMessage && now - this.gc.lastMessage > 300_000;
        // watchdog 2: the market SHOULD be open (calendar) but no print has
        // arrived for 3 minutes → the trade subscription is dead; reconnect.
        // The old version required vendor volume to be MOVING — exactly what
        // a dead feed can never show — so it sat silent across whole
        // sessions (the 9:30 open-drive window saw no data for days).
        const tradesStale =
          marketOpenAt(now) &&
          this.gc.lastTradeMs > 0 &&
          now - this.gc.lastTradeMs > 180_000 &&
          now - this.lastForcedReconnectMs > 180_000;
        if (dead || tradesStale) {
          this.lastForcedReconnectMs = now;
          console.log(
            `[live] forced reconnect (${dead ? "socket silent" : `no print for ${Math.round((now - this.gc.lastTradeMs) / 1000)}s while market open`})`,
          );
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
        }
      }
      // ---- tape-gap self-heal ladder (market-open only: the 17:00–18:00
      //      halt can never confirm candles and must not trip it) ----
      if (marketOpenAt(now)) {
        const tail = this.tickTail();
        const total = this.gc.minutes.length;
        // bars-frozen watchdog (2026-10-15): a frozen tail while the market
        // trades means the vendor data pipeline stopped completing bars
        // (candles stale + tick frames replaying old stamps) — the ladder's
        // tail-count trigger can't see it, so feed it a synthetic stall and
        // page the operator. BOOT-GRACE GATE (2026-10-15 false alarm): the
        // page requires the tail to have ADVANCED at least once since boot
        // and then stalled — a freshly reseeded buffer with an old tail is
        // a deploy artifact, not a vendor freeze.
        const tailCloseNow = liveMinuteCloseMs(this.gc.minutes[this.gc.minutes.length - 1] as { t: string; du?: string });
        if (tailCloseNow > this.lastTailClose) {
          this.lastTailClose = tailCloseNow;
          this.tailAdvancedAt = now;
        }
        const frozen = tapeTailStale(this.gc.minutes, now) && this.tailAdvancedAt > 0 && now - this.tailAdvancedAt > STALE_BARS_RECOVERY_MS;
        if (frozen) {
          if (now - this.frozenLoggedAt >= 60_000) {
            this.frozenLoggedAt = now;
            const close = liveMinuteCloseMs(this.gc.minutes[this.gc.minutes.length - 1] as { t: string; du?: string });
            console.log(`[live] BARS FROZEN — tail close ${Math.round((now - close) / 1000)}s ago while the market is open (vendor pipeline stalled)`);
          }
          if (now - this.frozenPageAt >= 30 * 60_000) {
            this.frozenPageAt = now;
            void sendTelegram(
              [
                `🚨 <b>VENDOR DATA FROZEN</b> — bars stopped completing`,
                `<code>${new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</code>`,
                `The tail bar closed ${Math.round((now - liveMinuteCloseMs(this.gc.minutes[this.gc.minutes.length - 1] as { t: string; du?: string })) / 1000)}s ago while the market is open — the self-heal ladder is force-fetching/reconnecting/reseeding. ${this.nqArb.active === "tv" ? "Tradovate is serving live bars — this is the GC STANDBY (no fail-over available while it is frozen)." : "No signals can fire until the vendor stream resumes."}`,
              ].join("\n"),
              { parseMode: "HTML" },
            ).catch(() => {});
          }
        }
        const prev = this.gc.heal; // pre-decision state carries the episode's ladder usage
        const { next, action } = tapeHealDecision(prev, now, frozen ? TAPE_HEAL_TAIL_ALERT + 1 : tail, frozen ? total - 1 : total);
        this.gc.heal = next;
        if (action === "force-fetch") {
          console.log(`[heal] unconfirmed tail ${tail} — forced candle fetch (${next.forcedFetches}/${TAPE_HEAL_MAX_FORCED_FETCHES})`);
          this.refreshCandles(true);
        } else if (action === "force-reconnect") {
          console.log(`[heal] unconfirmed tail ${tail} — forced reconnect to re-seed the FOOTPRINT/V2 frame channel`);
          try {
            this.ws?.close(); // onclose → backoff reconnect → subscribeChannels
          } catch {
            /* ignore */
          }
        } else if (action === "force-reseed") {
          console.log(`[heal] unconfirmed tail ${tail} — soft re-seed: clearing the buffer and re-bootstrapping`);
          this.gc.minutes = [];
          this.gc.cur = null;
          this.gc.ticks = [];
          this.gc.es.minutes = [];
          this.gc.es.cur = null;
          this.bootstrapped = false;
          void this.bootstrap();
        } else if (next.healedAt > 0 && next.healedAt !== this.healLoggedAt) {
          this.healLoggedAt = next.healedAt;
          console.log(
            `[heal] tail confirmed — episode ${next.episodes} closed (fetches ${prev.forcedFetches} · reconnects ${prev.reconnects} · re-seeds ${prev.reseeds} · ${Math.round((next.healedAt - prev.sinceAt) / 1000)}s)`,
          );
          // daybook hook: the durable per-day stall log (episode counter,
          // ladder steps, duration) — survives redeploys and feeds the
          // post-session report even with no DATABASE_URL.
          try {
            appendDaybook({
              t: "heal",
              at: next.healedAt,
              episode: next.episodes,
              sinceAt: prev.sinceAt,
              closedAt: next.healedAt,
              forcedFetches: prev.forcedFetches,
              reconnects: prev.reconnects,
              reseeds: prev.reseeds,
            });
          } catch {
            /* journaling is best-effort */
          }
        }
      }
      void this.bootstrap();
      if (globexOpen()) this.refreshCandles();
      this.emit();
    }, 5000);
  }
}

/** Replace completed tick-built minutes with the vendor's footprint candles
 * (totals AND per-price levels) so the signal engine evaluates exactly the
 * bars the archive — and every backtest — was computed on. The developing
 * minute (key >= nowKey) is left to live ticks. Pure — unit-tested. */
export function mergeCandleMinutes(
  minutes: LiveMinute[],
  candles: BootCandle[],
  nowKey: string,
): { replaced: number; added: number } {
  const byKey = new Map(minutes.map((m) => [`${m.du ?? ""}|${m.t}`, m]));
  let replaced = 0;
  let added = 0;
  for (const c of candles) {
    const ms = Date.parse(c.t);
    if (!Number.isFinite(ms)) continue;
    const iso = new Date(ms).toISOString();
    const du = iso.slice(0, 10);
    const hhmm = iso.slice(11, 16);
    const key = `${du}|${hhmm}`;
    if (key >= nowKey) continue; // developing minute — ticks own it
    if (!(c.high > 0) || !(c.low > 0)) continue;
    const levels: Record<string, [number, number]> | undefined = c.levels?.length
      ? Object.fromEntries(c.levels.map((l) => [(l.level / 100).toFixed(2), [l.buy, l.sell]]))
      : undefined;
    const levelTrades: Record<string, [number, number]> | undefined = c.levels?.length
      ? Object.fromEntries(c.levels.map((l) => [(l.level / 100).toFixed(2), [l.bTrades ?? 0, l.sTrades ?? 0]]))
      : undefined;
    const bar: LiveMinute = {
      t: hhmm,
      du,
      o: 0, // footprint candles carry no open/close — mid fallback, same as the archive
      h: c.high / 100,
      l: c.low / 100,
      c: 0,
      vol: c.buy + c.sell,
      buy: c.buy,
      sell: c.sell,
      live: true,
      source: "candle",
      levels,
      levelTrades,
    };
    const prev = byKey.get(key);
    if (prev) {
      // the candle is authoritative; keep tick-built levels only when the
      // candle carried none (defensive — never blank a usable footprint)
      Object.assign(prev, bar, { levels: levels ?? prev.levels, levelTrades: levelTrades ?? prev.levelTrades });
      replaced++;
    } else {
      byKey.set(key, bar);
      minutes.push(bar);
      added++;
    }
  }
  if (added) {
    minutes.sort((a, b) => `${a.du ?? ""}|${a.t}`.localeCompare(`${b.du ?? ""}|${b.t}`));
    if (minutes.length > MAX_MINUTES) minutes.splice(0, minutes.length - MAX_MINUTES);
  }
  return { replaced, added };
}

const g = globalThis as unknown as { __gcLive?: LiveFeed };

export function getLive(): LiveFeed {
  if (!g.__gcLive) {
    g.__gcLive = new LiveFeed();
    g.__gcLive.start();
  }
  return g.__gcLive;
}
