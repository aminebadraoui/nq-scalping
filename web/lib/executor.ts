/* ------------------------------------------------------------------ *
 * Trade executor — places the sweep-reclaim order on the MFF Tradovate
 * account.
 *
 * MyFundedFutures exposes no Tradovate API, so the only free path is a
 * headless browser (Playwright) driving trader.tradovate.com. Until that
 * is wired, this is a DRY-RUN: it logs the exact order intent. Set
 * EXECUTE_LIVE=1 to switch on the (not-yet-implemented) live path.
 *
 * Credentials come from env: TRADOVATE_USERNAME / TRADOVATE_PASSWORD
 * (gitignored). NEVER log them.
 * ------------------------------------------------------------------ */

export type OrderIntent = {
  symbol: string;
  dir: "long" | "short";
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  timeET: string;
};

export function executorEnabled(): boolean {
  return !!process.env.TRADOVATE_USERNAME && !!process.env.TRADOVATE_PASSWORD;
}

/**
 * Place a bracket order (entry + stop + target). Dry-run by default — logs the
 * intent and does nothing else. Live execution is a Playwright TODO below.
 */
export async function placeOrder(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  if (!executorEnabled()) return { ok: false, reason: "TRADOVATE_* not configured" };

  const live = process.env.EXECUTE_LIVE === "1";
  const side = intent.dir === "long" ? "BUY" : "SELL";
  const line =
    `[executor] ${live ? "LIVE" : "DRY-RUN"} ${side} ${intent.contracts} ${intent.symbol} ` +
    `entry ${intent.entry.toFixed(2)} · stop ${intent.stop.toFixed(2)} · target ${intent.target.toFixed(2)} · ${intent.timeET} NY`;

  if (!live) {
    console.log(line);
    return { ok: true, reason: "dry-run (logged only)" };
  }

  // TODO(playwright): log into trader.tradovate.com and fill the bracket ticket.
  //   1. await import("playwright"); launch chromium (headless).
  //   2. page.goto("https://trader.tradovate.com"); login with TRADOVATE_*.
  //   3. select MNQ, set qty + stop/target, submit.
  //   4. screenshot/confirm, return the fill.
  return { ok: false, reason: "EXECUTE_LIVE=1 but the Playwright path is not implemented yet" };
}
