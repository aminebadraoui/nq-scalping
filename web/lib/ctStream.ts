/* ------------------------------------------------------------------ *
 * CrossTrade WebSocket order-event stream — pushed, not polled.
 *
 * Subscribes to Tradovate order events on wss://app.crosstrade.io/ws/stream
 * (Bearer auth, origin=tradovate). Every order state transition arrives
 * as an orderUpdate frame; a Rejected STOP leg is reacted to instantly
 * (lib/crossTrade.ts reactToPushedStopRejection) instead of waiting for
 * the burst poller or the 10s watchdog. The P&L stream (streamPnl)
 * doubles as a liveness heartbeat — a silent connection is
 * force-reconnected.
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
/** the liveness watchdog closed the socket itself (the stream was
 *  silent) — the mirror hydration survives such reconnects (nothing
 *  could have been missed while silent) instead of forcing a REST
 *  re-seed that feeds the already-exhausted demo-login budget */
let selfClosed = false;
let livenessTimer: ReturnType<typeof setInterval> | null = null;
let bootLogged = false;

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
    // no markResync here: an ABNORMAL close already un-hydrated the
    // mirror in onclose; a liveness-forced reconnect keeps the
    // hydration (the stream was silent — nothing was missed, and a
    // REST re-seed here would feed the exhausted login's budget).
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
      // streamPnl stays enabled purely as the liveness heartbeat — a flat,
      // quiet account emits no order frames, and the pnl cadence is what
      // keeps the connection from force-reconnecting. No handler (the
      // P&L-based flatten arm was removed 2026-10-15).
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
    if (!selfClosed) ctWsMarkResync(); // abnormal disconnect — the mirror is untrusted until re-seeded
    selfClosed = false;
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
      selfClosed = true;
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
