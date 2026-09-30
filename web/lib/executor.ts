/* ------------------------------------------------------------------ *
 * Trade executor — places the sweep-reclaim order on the MFF Tradovate
 * account. MyFundedFutures exposes no API, so the free path is a headless
 * Chromium (Playwright) driving trader.tradovate.com.
 *
 * Verified (2026-09-30, headless):
 *   · login:  fill #name-input / #password-input, click "Login"
 *   · mode:   click "Access Simulation" (the MFF eval/funded environment)
 *   · ticket: Buy Mkt / Sell Mkt / Buy Bid / Sell Ask buttons, a quantity
 *     combobox (input[placeholder="Select value"]), instrument combobox
 *
 * Default is DRY-RUN (logs only). EXECUTE_LIVE=1 switches to the real path —
 * NOT YET SAFE TO ENABLE: the market-entry path is written but untested, and
 * bracket (stop + target) attachment is still TODO. Test with 1 contract on
 * Simulation first. Credentials come from env (gitignored), never logged.
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

function loadCreds(): { username: string; password: string } | null {
  const username = process.env.TRADOVATE_USERNAME ?? "";
  const password = process.env.TRADOVATE_PASSWORD ?? "";
  return username && password ? { username, password } : null;
}

/** Persistent headless session (login once, reuse across signals). */
let session: { page: unknown } | null = null;

async function getPage(): Promise<unknown> {
  if (session) return session.page;
  const { chromium } = await import("playwright");
  const creds = loadCreds();
  if (!creds) throw new Error("TRADOVATE_* not configured");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#name-input", { timeout: 30_000 });
  await page.fill("#name-input", creds.username);
  await page.fill("#password-input", creds.password);
  await page.click("button:has-text('Login')");
  await page.waitForTimeout(4000);
  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) {
    await sim.click();
    await page.waitForTimeout(8000);
  }
  session = { page };
  return page;
}

/** Live market-order entry. Untested — verify with 1 contract before enabling. */
async function placeOrderLive(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  if (intent.contracts < 1 || intent.contracts > 30) {
    return { ok: false, reason: `refusing size ${intent.contracts} (outside 1..30)` };
  }
  const page = (await getPage()) as {
    fill: (s: string, v: string) => Promise<void>;
    locator: (s: string) => { first: () => { count: () => Promise<number>; click: () => Promise<void> } };
    screenshot: (o: { path: string }) => Promise<void>;
  };

  // quantity (the order-ticket combobox)
  await page.fill('input[placeholder="Select value"]', String(intent.contracts));
  // market entry
  const label = intent.dir === "long" ? "Buy Mkt" : "Sell Mkt";
  const btn = page.locator(`div:has-text("${label}")`).first();
  await btn.click();
  await page.screenshot({ path: "/tmp/tradovate_order.png" });
  return { ok: true, reason: `submitted ${label} ${intent.contracts} MNQ (bracket NOT attached — TODO)` };
}

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
  try {
    return await placeOrderLive(intent);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
