/* ------------------------------------------------------------------ *
 * Trade executor — routes every order intent to the CrossTrade
 * backend, the only execution path.
 *
 * The former Playwright browser path (headed Chromium driving
 * trader.tradovate.com) was removed — CrossTrade handles the MFF
 * Tradovate account via its cloud REST API / webhook.
 *
 * When CROSSTRADE_* is configured, placeOrder() places the bracketed
 * entry via the REST API — ABSOLUTE stop/target at the signal's
 * structural levels. CROSSTRADE_REST=0 falls back to the
 * quote-anchored webhook.
 *
 * Default DRY-RUN logs only. EXECUTE_LIVE=1 switches to the real path.
 * Credentials come from env (gitignored), never logged.
 * ------------------------------------------------------------------ */

import { cancelCrossTradeOrderREST, crossTradeEnabled, placeCrossTradeOrder, placeCrossTradeOrderREST, placeCrossTradeScaleOut, placeCrossTradeScaleOutREST, withPlacementLock } from "./crossTrade";
import { markDispatch } from "./execLatency";

export type OrderIntent = {
  symbol: string;
  dir: "long" | "short";
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  timeET: string;
};

export type PlaceOpts = {
  /** resting LIMIT entry at this price (with our own orderId so a later
   *  cancel can address it) instead of the default market entry */
  limitPrice?: number;
  /** human label for the protection alerts (the post-place leg check) */
  label?: string;
  /** our order id for a MARKET entry too (needed to CHANGE its stop later) */
  orderId?: string;
  /** the strategy set this order belongs to. Since 2026-10-27 only the
   *  eval plan ("eval_v1") places orders; every other caller is
   *  signal-only unless LEGACY_EXEC=1 (the legacy families lose money at
   *  reachable fills — docs/research/honest-fills-2026-10-26.md). */
  plan?: "eval_v1";
};

/** legacy (pre-eval-plan) strategies may place orders only with LEGACY_EXEC=1 */
export function legacyExecEnabled(): boolean {
  return process.env.LEGACY_EXEC === "1";
}

/** Place a bracketed entry through CrossTrade. The REST path (ABSOLUTE
 *  stop/target at the signal's structural levels) is the default;
 *  CROSSTRADE_REST=0 falls back to the quote-anchored webhook.
 *  opts.limitPrice switches the entry to a resting limit.
 *  The child ids (native entry + OSO stop/target) come back so the
 *  protection watchdog can verify the legs after placement — an
 *  accepted place can still be rejected by Tradovate's risk layer a
 *  split second later (InvalidPrice on a crossed stop). */
export async function placeOrder(
  intent: OrderIntent,
  opts: PlaceOpts = {},
): Promise<{
  ok: boolean;
  reason: string;
  orderId?: string;
  nativeEntryId?: string | number;
  stopChildId?: string | number;
  targetChildId?: string | number;
}> {
  if (opts.plan !== "eval_v1" && !legacyExecEnabled()) {
    return { ok: false, reason: "legacy strategy is signal-only (eval plan v1 owns execution; LEGACY_EXEC=1 re-enables)" };
  }
  const t0 = performance.now();
  try {
    if (crossTradeEnabled()) {
      // `return await`: inside try/finally a bare `return promise` runs the
      // finally (markDispatch) BEFORE the placement settles — the dispatch
      // stage was recorded as ~0 ms
      if (process.env.CROSSTRADE_REST === "0") {
        // the webhook path has no limit orders: it would send a resting-limit
        // card as a MARKET entry with no orderId the watcher could cancel
        if (opts.limitPrice !== undefined) {
          return { ok: false, reason: "limit entries need the REST path (CROSSTRADE_REST=0 is set) — not sent" };
        }
        // same one-at-a-time lock as the REST path (stacking race)
        return await withPlacementLock(() => placeCrossTradeOrder(intent));
      }
      return await placeCrossTradeOrderREST(intent, opts);
    }
    return { ok: false, reason: "CrossTrade not configured (CROSSTRADE_URL/KEY/ACCOUNT)" };
  } finally {
    // telemetry: the dispatch stage = send to CrossTrade + placement ack.
    // detectLagMs = how far into the current minute this ran, i.e. the lag
    // since the trigger bar closed (0 = fired the moment the bar completed).
    markDispatch(performance.now() - t0, Date.now() % 60_000);
  }
}

/** Cancel a resting order by our user-assigned orderId (the limit-entry
 *  expiry path). No-op when CrossTrade is off. */
export async function cancelOrder(orderId: string): Promise<{ ok: boolean; reason: string }> {
  if (!crossTradeEnabled()) return { ok: false, reason: "CrossTrade not configured" };
  return cancelCrossTradeOrderREST(orderId);
}

/** Place the scale-out pair (bank 2/3 + runner 1/3). REST absolute
 *  brackets are the default — the runner's stop is the signal's
 *  structural level, never a quote-anchored tick distance.
 *  CROSSTRADE_REST=0 or CROSSTRADE_SCALEOUT_REST=0 returns to the
 *  quote-anchored webhook pair. */
export async function placeScaleOut(
  intent: OrderIntent,
): Promise<{ ok: boolean; reason: string; bankOrderId?: string; runnerOrderId?: string; runnerQty?: number }> {
  if (!legacyExecEnabled()) {
    return { ok: false, reason: "legacy strategy is signal-only (eval plan v1 owns execution; LEGACY_EXEC=1 re-enables)" };
  }
  const t0 = performance.now();
  try {
    if (!crossTradeEnabled()) {
      return { ok: false, reason: "CrossTrade not configured (CROSSTRADE_URL/KEY/ACCOUNT)" };
    }
    return await (process.env.CROSSTRADE_REST === "0" || process.env.CROSSTRADE_SCALEOUT_REST === "0"
      ? withPlacementLock(() => placeCrossTradeScaleOut(intent))
      : placeCrossTradeScaleOutREST(intent));
  } finally {
    markDispatch(performance.now() - t0, Date.now() % 60_000);
  }
}
