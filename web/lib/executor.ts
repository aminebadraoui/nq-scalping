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

import { cancelCrossTradeOrderREST, crossTradeEnabled, placeCrossTradeOrder, placeCrossTradeOrderREST, placeCrossTradeScaleOut, placeCrossTradeScaleOutREST } from "./crossTrade";
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
};

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
  const t0 = performance.now();
  try {
    if (crossTradeEnabled()) {
      return process.env.CROSSTRADE_REST === "0"
        ? placeCrossTradeOrder(intent)
        : placeCrossTradeOrderREST(intent, opts);
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
  const t0 = performance.now();
  try {
    if (!crossTradeEnabled()) {
      return { ok: false, reason: "CrossTrade not configured (CROSSTRADE_URL/KEY/ACCOUNT)" };
    }
    return process.env.CROSSTRADE_REST === "0" || process.env.CROSSTRADE_SCALEOUT_REST === "0"
      ? placeCrossTradeScaleOut(intent)
      : placeCrossTradeScaleOutREST(intent);
  } finally {
    markDispatch(performance.now() - t0, Date.now() % 60_000);
  }
}
