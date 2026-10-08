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

let started = false;
let sock: WebSocket | null = null;
let backoffMs = 5_000;
let lastFrameAt = 0;
let livenessTimer: ReturnType<typeof setInterval> | null = null;

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
    next.send(JSON.stringify({ action: "subscribe", events: ["orders"], origin: "tradovate" }));
    next.send(JSON.stringify({ action: "streamPnl", enabled: true, origin: "tradovate" }));
  };
  next.onmessage = (ev) => {
    lastFrameAt = Date.now();
    let msg: { type?: string; origin?: string; order?: Record<string, unknown> } | null = null;
    try {
      msg = JSON.parse(String(ev.data)) as { type?: string; origin?: string; order?: Record<string, unknown> };
    } catch {
      return;
    }
    if (!msg || msg.type !== "orderUpdate" || msg.origin !== "tradovate") return;
    const o = msg.order ?? {};
    const status = String(o.ordStatus ?? o.orderState ?? "");
    if (status === "Rejected") {
      void reactToPushedStopRejection(String(o.id ?? ""), String(o.action ?? "")).catch(() => {});
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
