/* ------------------------------------------------------------------ *
 * CrossTrade WebSocket order-event stream — pushed, not polled.
 *
 * Subscribes to Tradovate order events on wss://app.crosstrade.io/ws/stream
 * (Bearer auth, origin=tradovate). Every order state transition arrives
 * as an orderUpdate frame; a Rejected STOP leg is reacted to instantly
 * (lib/crossTrade.ts reactToPushedStopRejection) instead of waiting for
 * the burst poller or the 10s watchdog. The P&L stream doubles as a
 * liveness heartbeat — a silent connection is force-reconnected.
 *
 * One connection per user is enforced server-side; reconnects use
 * exponential backoff under the 5-upgrades/IP/60s limit. Started from
 * instrumentation; no-op unless EXECUTE_LIVE=1.
 * ------------------------------------------------------------------ */

import { reactToPushedStopRejection } from "./crossTrade";
import { onPushedEntryFill } from "./execWatch";
import { ctApplyWsFrame, ctWsHeartbeat, ctWsMarkResync } from "./ctAccount";

let started = false;
let sock: WebSocket | null = null;
let backoffMs = 5_000;
let lastFrameAt = 0;
let livenessTimer: ReturnType<typeof setInterval> | null = null;
let bootLogged = false;

/** pushed P&L frame handler (registered by instrumentation → crossGuard):
 *  the sub-second trigger for the flatten arm. Null = no handler. */
export type PushedPnl = { name: string; realized: number; openPnl: number; equity: number };
let pnlFrameHandler: ((a: PushedPnl) => void) | null = null;
export function setPnlFrameHandler(fn: ((a: PushedPnl) => void) | null): void {
  pnlFrameHandler = fn;
}

/** pure parser for the CrossTrade pnlUpdate frame (captured live
 *  2026-10-12):
 *    {"type":"pnlUpdate","origin":"tradovate","accounts":[{"name":…,
 *     "stats":{"pnl":…},"pnl":{"unrealized":…},"netLiquidation":…}]}
 *  Returns the per-account rows, or null when the frame isn't a
 *  tradovate pnlUpdate. */
export function parsePnlUpdate(msg: unknown): PushedPnl[] | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: unknown; origin?: unknown; accounts?: unknown };
  if (m.type !== "pnlUpdate" || m.origin !== "tradovate" || !Array.isArray(m.accounts)) return null;
  const out: PushedPnl[] = [];
  for (const raw of m.accounts) {
    const a = raw as { name?: unknown; stats?: { pnl?: unknown }; pnl?: { unrealized?: unknown }; netLiquidation?: unknown };
    const realized = Number(a.stats?.pnl);
    const openPnl = Number(a.pnl?.unrealized);
    const equity = Number(a.netLiquidation);
    if (typeof a.name === "string" && Number.isFinite(realized) && Number.isFinite(openPnl) && Number.isFinite(equity)) {
      out.push({ name: a.name, realized, openPnl, equity });
    }
  }
  return out.length ? out : null;
}

const STALE_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

function scheduleReconnect(): void {
  if (!started) return;
  const wait = backoffMs;
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
  setTimeout(() => connect(), wait);
}

function connect(): void {
  if (!started || !process.env.CROSSTRADE_KEY) return;
  let next: WebSocket;
  try {
    // Node's global WebSocket (undici) accepts headers in the options
    next = new WebSocket("wss://app.crosstrade.io/ws/stream", {
      headers: { Authorization: `Bearer ${process.env.CROSSTRADE_KEY}` },
    } as never);
  } catch (e) {
    console.warn(`[ctStream] connect failed: ${String(e)}`);
    scheduleReconnect();
    return;
  }
  sock = next;
  next.onopen = () => {
    backoffMs = 5_000;
    lastFrameAt = Date.now();
    // (re)connect: the state mirror must re-seed over REST before the
    // pushed frames are trusted (replayed events are incomplete — the
    // vendor's resync guidance). Pnl/status frames heartbeat it.
    ctWsMarkResync();
    next.send(JSON.stringify({ action: "subscribe", events: ["orders", "executions", "positions"], origin: "tradovate" }));
    next.send(JSON.stringify({ action: "streamPnl", enabled: true, origin: "tradovate" }));
    if (!bootLogged) {
      bootLogged = true;
      console.log("[ctStream] connected — subscribed orders/executions/positions + streamPnl (tradovate)");
    }
  };
  next.onmessage = (ev) => {
    lastFrameAt = Date.now();
    ctWsHeartbeat();
    let msg: {
      type?: string;
      origin?: string;
      order?: Record<string, unknown>;
      position?: Record<string, unknown>;
      execution?: Record<string, unknown>;
    } | null = null;
    try {
      msg = JSON.parse(String(ev.data)) as { type?: string; origin?: string; order?: Record<string, unknown>; position?: Record<string, unknown>; execution?: Record<string, unknown> };
    } catch {
      return;
    }
    if (!msg || msg.origin !== "tradovate") return;
    // free frames keep the shared state mirror current (lib/ctAccount) —
    // the poll helpers serve it instead of spending the REST budget
    if (msg.type === "orderUpdate" && msg.order) ctApplyWsFrame("order", msg.order);
    if (msg.type === "positionUpdate" && msg.position) ctApplyWsFrame("position", msg.position);
    if (msg.type === "pnlUpdate") {
      // pushed P&L (streamPnl): the flatten arm's sub-second trigger —
      // the handler re-evaluates the guard with the pushed open P&L.
      const rows = parsePnlUpdate(msg);
      if (rows && pnlFrameHandler) {
        for (const a of rows) {
          try {
            pnlFrameHandler(a);
          } catch {
            /* best-effort — the 25s poll is the backstop */
          }
        }
      }
      return;
    }
    if (msg.type !== "orderUpdate") return;
    const o = msg.order ?? {};
    const status = String(o.ordStatus ?? o.orderState ?? "");
    if (status === "Rejected") {
      void reactToPushedStopRejection(String(o.id ?? ""), String(o.action ?? "")).catch(() => {});
    } else if (status === "Filled") {
      // pushed ENTRY fill (2026-10-12): confirm it immediately instead of
      // waiting for the 5s timer + fill-cache refresh — time exits then
      // register at the TRUE fill time and the protection sweep runs now.
      // The immediate pass only matches fills; it can never re-send/drop.
      void onPushedEntryFill(String(o.action ?? ""), o).catch(() => {});
    }
  };
  next.onclose = () => {
    sock = null;
    scheduleReconnect();
  };
  next.onerror = () => {
    /* onclose follows */
  };
}

/** start the order-event stream (idempotent). Also runs a liveness
 *  watchdog: no frame for 30s → the connection is dead → reconnect. */
export function startCtOrderStream(): void {
  if (started) return;
  if (process.env.EXECUTE_LIVE !== "1") return;
  if (!process.env.CROSSTRADE_KEY) return;
  started = true;
  connect();
  livenessTimer = setInterval(() => {
    if (sock && Date.now() - lastFrameAt > STALE_AFTER_MS) {
      console.warn("[ctStream] no frames for 30s — forcing reconnect");
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      sock = null;
      connect();
    }
  }, 15_000);
  if (typeof livenessTimer.unref === "function") livenessTimer.unref();
}

/** TEST ONLY: stop the stream. */
export function __stopCtOrderStreamForTest(): void {
  started = false;
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
  if (sock) {
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    sock = null;
  }
}
