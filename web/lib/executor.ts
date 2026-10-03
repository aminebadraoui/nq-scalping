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

import { crossTradeEnabled, placeCrossTradeOrder, placeCrossTradeOrderREST } from "./crossTrade";

export type OrderIntent = {
  symbol: string;
  dir: "long" | "short";
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  timeET: string;
};

/** Place a bracketed entry through CrossTrade. The REST path (ABSOLUTE
 *  stop/target at the signal's structural levels) is the default;
 *  CROSSTRADE_REST=0 falls back to the quote-anchored webhook. */
export async function placeOrder(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  if (crossTradeEnabled()) {
    return process.env.CROSSTRADE_REST === "0"
      ? placeCrossTradeOrder(intent)
      : placeCrossTradeOrderREST(intent);
  }
  return { ok: false, reason: "CrossTrade not configured (CROSSTRADE_URL/KEY/ACCOUNT)" };
}
