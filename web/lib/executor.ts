/* ------------------------------------------------------------------ *
 * Trade executor — places the sweep-reclaim order on the MFF Tradovate
 * account. MyFundedFutures exposes no API, so the free path is a headless
 * Chromium (Playwright) driving trader.tradovate.com.
 *
 * Verified headless (2026-09-30):
 *   · login:  #name-input / #password-input, then "Login"
 *   · mode:   "Access Simulation" (the MFF eval/funded environment)
 *   · ticket: quantity input[placeholder="Select value"]; Buy Mkt / Sell Mkt
 *   · bracket: TP/SL dropdown [data-testid="simple-tpsl-atm-strategy-select"]
 *              → #add-tpsl-option → bracket-0-take-profit-input / stop-loss-input
 *              (both entered in TICKS, MNQ tick = 0.25 pt)
 *
 * Default DRY-RUN logs only. EXECUTE_LIVE=1 switches to the real path — STILL
 * UNTESTED: test with 1 contract on Simulation and review the screenshot before
 * enabling for real sizing. Credentials come from env (gitignored), never logged.
 * ------------------------------------------------------------------ */

import type { Page } from "playwright";

export type OrderIntent = {
  symbol: string;
  dir: "long" | "short";
  contracts: number;
  entry: number;
  stop: number;
  target: number;
  timeET: string;
};

const TICK = 0.25; // MNQ

export function executorEnabled(): boolean {
  return !!process.env.TRADOVATE_USERNAME && !!process.env.TRADOVATE_PASSWORD;
}

function loadCreds(): { username: string; password: string } | null {
  const username = process.env.TRADOVATE_USERNAME ?? "";
  const password = process.env.TRADOVATE_PASSWORD ?? "";
  return username && password ? { username, password } : null;
}

/** Persistent headless session (login once, reuse across signals). */
let session: { page: Page } | null = null;

async function getPage(): Promise<Page> {
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
    await page.waitForTimeout(10_000);
  }
  session = { page };
  return page;
}

/** Live bracketed market order. Untested — verify with 1 contract first. */
async function placeOrderLive(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  if (intent.contracts < 1 || intent.contracts > 30) {
    return { ok: false, reason: `refusing size ${intent.contracts} (outside 1..30)` };
  }
  const page = await getPage();

  // ensure the simple TP/SL bracket is enabled (reveals the tick fields)
  const hasBracket = (await page.locator('[data-testid="bracket-0-take-profit-input"]').count()) > 0;
  if (!hasBracket) {
    await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().click();
    await page.waitForTimeout(800);
    await page.locator("#add-tpsl-option").first().click();
    await page.waitForTimeout(1500);
  }

  const stopTicks = Math.max(1, Math.round(Math.abs(intent.entry - intent.stop) / TICK));
  const targetTicks = Math.max(1, Math.round(Math.abs(intent.target - intent.entry) / TICK));

  await page.fill('[data-testid="bracket-0-stop-loss-input"]', String(stopTicks));
  await page.fill('[data-testid="bracket-0-take-profit-input"]', String(targetTicks));
  await page.fill('input[placeholder="Select value"]', String(intent.contracts));

  const label = intent.dir === "long" ? "Buy Mkt" : "Sell Mkt";
  await page.locator(`div:has-text("${label}")`).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/tradovate_order.png" });

  return {
    ok: true,
    reason: `submitted ${label} ${intent.contracts} MNQ bracketed (stop ${stopTicks}t / target ${targetTicks}t)`,
  };
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
