/* ------------------------------------------------------------------ *
 * SSE emission throttle (2026-10-16 outage fix).
 *
 * /api/live emits the FULL live state (footprint buffer + levels,
 * ~1MB JSON) on every tick. During RTH the tick rate is hundreds per
 * minute — with a connected dashboard client the per-tick serialize
 * saturated the single-threaded server, the Coolify health check
 * timed out, the health-check curls piled up (647 zombies), and
 * Traefik 503'd the dashboard mid-session.
 *
 * sseThrottle wraps a send function with a TRAILING-EDGE throttle:
 * one event at most every gapMs; the first call always passes through
 * (the dashboard's initial snapshot), later events within the gap are
 * coalesced to the LATEST state and flushed when the gap elapses —
 * the client never misses the newest state, it just receives fewer
 * intermediate frames. Pure + unit-tested.
 * ------------------------------------------------------------------ */

export type ThrottledSender = (data: unknown) => void;

export function sseThrottle(
  send: (data: unknown) => void,
  opts: { gapMs?: number; now?: () => number; setTimeoutFn?: (fn: () => void, ms?: number) => unknown; clearTimeoutFn?: (id: unknown) => void } = {},
): ThrottledSender & { flush: () => void } {
  const gapMs = opts.gapMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const setTimeoutFn = (opts.setTimeoutFn ?? setTimeout) as (fn: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  const clearTimeoutFn = (opts.clearTimeoutFn ?? clearTimeout) as (id: unknown) => void;

  let lastSentAt: number | null = null;
  let pending: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (pending !== null) {
      lastSentAt = now();
      const data = pending;
      pending = null;
      send(data);
    }
  };

  const throttled: ThrottledSender & { flush: () => void } = (data: unknown) => {
    const t = now();
    if (lastSentAt === null || t - lastSentAt >= gapMs) {
      lastSentAt = t;
      send(data);
      return;
    }
    // within the gap: keep only the latest state and schedule one flush
    pending = data;
    if (timer === null) {
      timer = setTimeoutFn(() => {
        timer = null;
        flush();
      }, Math.max(0, lastSentAt + gapMs - t));
    }
  };
  throttled.flush = flush;
  return throttled;
}
