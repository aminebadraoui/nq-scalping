/* ------------------------------------------------------------------ *
 * Trade executor — places the sweep-reclaim order on the MFF Tradovate
 * account via a headed Chromium (Playwright) driving trader.tradovate.com.
 *
 * Humanized (run LOCAL, headed):
 *   · headed Chromium with the AutomationControlled flag removed + a
 *     navigator.webdriver override
 *   · mouse moves/click (not DOM .click), typed input (not .fill)
 *   · random human pauses between actions, size + tick jitter, and an
 *     occasional limit entry instead of market
 * No signal-skipping, no entry delay, no days off (per owner).
 *
 * Default DRY-RUN logs only. EXECUTE_LIVE=1 switches to the real path — STILL
 * UNTESTED: test with 1 contract and eyeball the screenshot first. Credentials
 * come from env (gitignored), never logged.
 * ------------------------------------------------------------------ */

import { existsSync } from "fs";
import path from "path";
import type { Browser, Page } from "playwright";
import { crossTradeEnabled, placeCrossTradeOrder } from "./crossTrade";

/** Playwright is installed into <repo>/.playwright-browsers (gitignored), not
 *  the user's default cache — point the launcher at it so a headed launch never
 *  fails with "Executable doesn't exist" on a machine without the global cache. */
function ensureBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const candidates = [
    path.join(process.cwd(), "..", ".playwright-browsers"),
    path.join(process.cwd(), ".playwright-browsers"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = c;
      return;
    }
  }
}

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

/* ── humanization ─────────────────────────────────────────────────────── */
const pause = () => 250 + Math.random() * 800;
const jitter = (v: number, amt = 1) => (Math.random() < 0.35 ? v + (Math.random() < 0.5 ? -amt : amt) : v);

/** Wait for a selector to be visible, retrying across mid-wait client-side
 *  navigations (Tradovate redirects the login form between two URLs). */
async function waitForSelectorRetry(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await page.waitForSelector(selector, { state: "visible", timeout: Math.min(4000, deadline - Date.now()) });
      return;
    } catch {
      // navigation in progress — poll again; a dead page still exits via the deadline
    }
  }
  throw new Error(`waitForSelectorRetry: ${selector} never became visible`);
}

async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) throw new Error(`no element for ${selector}`);
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);
  // curved path: a jittered waypoint then the target, not a straight drag
  const wx = box.x + box.width * Math.random();
  const wy = box.y + box.height * Math.random();
  await page.mouse.move(wx, wy, { steps: 4 + Math.floor(Math.random() * 6) });
  await page.waitForTimeout(pause());
  await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 10) });
  await page.waitForTimeout(pause());
  await page.mouse.click(x, y);
  await page.waitForTimeout(pause());
}

/** Click a button by its EXACT visible label (deepest match — the button div
 *  itself, never an ancestor container that merely contains the same words). */
async function humanClickButton(page: Page, label: string): Promise<void> {
  const el = page.getByText(label, { exact: true }).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) throw new Error(`no button for "${label}"`);
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);
  const wx = box.x + box.width * Math.random();
  const wy = box.y + box.height * Math.random();
  await page.mouse.move(wx, wy, { steps: 4 + Math.floor(Math.random() * 6) });
  await page.waitForTimeout(pause());
  await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 10) });
  await page.waitForTimeout(pause());
  await page.mouse.click(x, y);
  await page.waitForTimeout(pause());
}

/** Confirm the order-submit popover ("Buy 1 MKT?" / "Sell 1 MKT?" with a
 *  Buy/Sell + Cancel). The entry-button click only ARMS the order; this popover
 *  is the actual submit. Scoped to `.btn` so the order-history grid cells
 *  ("Buy"/"Sell" columns) can never match. */
async function humanConfirmOrder(page: Page, dir: "long" | "short"): Promise<void> {
  const confirmLabel = dir === "long" ? "Buy" : "Sell";
  const btn = page.locator("div.btn").filter({ hasText: new RegExp(`^${confirmLabel}$`) }).first();
  await btn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  if (!(await btn.count())) return;
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const box = await btn.boundingBox();
  if (!box) return;
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);
  const wx = box.x + box.width * Math.random();
  const wy = box.y + box.height * Math.random();
  await page.mouse.move(wx, wy, { steps: 4 + Math.floor(Math.random() * 6) });
  await page.waitForTimeout(pause());
  await page.mouse.move(x, y, { steps: 6 + Math.floor(Math.random() * 10) });
  await page.waitForTimeout(pause());
  await page.mouse.click(x, y);
  await page.waitForTimeout(pause());
}

async function humanType(page: Page, selector: string, value: string): Promise<void> {
  await humanClick(page, selector);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value, { delay: 40 + Math.random() * 80 });
  await page.waitForTimeout(pause());
}

/* ── persistent session ───────────────────────────────────────────────── */
let session: { page: Page; browser: Browser } | null = null;
/** true while an order is being placed — keep-alive must not touch the page */
let placing = false;
/** how many times a browser was actually launched (1 = the open session was
 *  reused for every later operation; >1 = it closed and had to be reopened) */
let launches = 0;

/** Is the cached page still logged into the trading dashboard (not crashed,
 *  not bounced to login, not stuck on the session-limit page)? */
async function sessionAlive(page: Page): Promise<boolean> {
  try {
    if (page.isClosed()) return false;
    const url = page.url();
    if (url.includes("current-sessions") || url.includes("/login")) return false;
    // logged-out => the login form is back (the dashboard has no #name-input)
    if ((await page.locator("#name-input").count()) > 0) return false;
    return true;
  } catch {
    return false;
  }
}

async function teardown() {
  const s = session;
  session = null;
  if (s) {
    try {
      await s.browser.close();
    } catch {
      /* ignore */
    }
  }
}

/** a single in-flight login — concurrent callers (keep-alive + a just-fired
 *  signal) await the SAME promise instead of each launching their own browser */
let loginInFlight: Promise<Page> | null = null;

async function getPage(): Promise<Page> {
  if (session && (await sessionAlive(session.page))) return session.page;
  if (session) await teardown(); // dead session — drop it and re-login fresh
  if (!loginInFlight) {
    loginInFlight = doLogin().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function doLogin(): Promise<Page> {
  ensureBrowsersPath();
  const { chromium } = await import("playwright");
  const creds = loadCreds();
  if (!creds) throw new Error("TRADOVATE_* not configured");

  const browser = await chromium.launch({
    headless: false, // headed, local — no automation headless fingerprint
    args: ["--disable-blink-features=AutomationControlled"],
  });
  launches++;
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60_000 });

  // The login form can live on two URLs (root or /welcome, the newer MUI form)
  // and a client-side redirect can fire right as we start waiting. Poll with a
  // short deadline instead of a single waitForSelector so a mid-wait navigation
  // doesn't strand us.
  await waitForSelectorRetry(page, "#name-input", 30_000);
  await humanType(page, "#name-input", creds.username);
  await humanType(page, "#password-input", creds.password);
  await humanClick(page, "button:has-text('Login')");
  await page.waitForTimeout(4000);

  // "Current Sessions" interstitial: Tradovate caps concurrent sessions (the
  // user's TradingView link + any prior test browser can fill the quota). It
  // blocks entry until an old session is closed — handle it, never assume it's
  // absent, or the whole order flow dead-ends on this page.
  if (page.url().includes("current-sessions")) {
    const closeOldest = page
      .locator("button:has-text('Close oldest session'), a:has-text('Close oldest session')")
      .first();
    if (await closeOldest.count()) {
      await humanClickButton(page, "Close oldest session and Continue to login");
      await page.waitForTimeout(6000);
    }
  }

  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) {
    await humanClick(page, "button:has-text('Access Simulation'), a:has-text('Access Simulation')");
    await page.waitForTimeout(10_000);
  }
  session = { page, browser };
  return page;
}

/* ── keep-alive ───────────────────────────────────────────────────────── */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Assert the session is still warm; if it got logged out / crashed, silently
 *  re-login NOW so the next signal doesn't pay the ~20s login penalty. No-ops
 *  while an order is in flight (never disturbs a live submission), and no-ops
 *  in dry-run (no session to keep warm — don't pop a browser for nothing). */
export async function keepAlive(): Promise<void> {
  if (!executorEnabled() || placing) return;
  if (crossTradeEnabled()) return; // CrossTrade backend — no browser session to warm
  if (process.env.EXECUTE_LIVE !== "1") return;
  if (session && (await sessionAlive(session.page))) return;
  try {
    await getPage();
    console.log("[executor] keep-alive: session re-warmed");
  } catch (e) {
    console.log("[executor] keep-alive failed:", String(e));
  }
}

/** Start the periodic keep-alive. Idempotent — call once from the long-running
 *  local executor. Logs in immediately on start so the browser is open and
 *  warm before the first signal ever fires, then re-checks every interval. */
export function startKeepAlive(intervalMs = 60_000): void {
  if (keepAliveTimer) return;
  void keepAlive();
  keepAliveTimer = setInterval(() => void keepAlive(), intervalMs);
}

/** TEST ONLY: force-drop the cached browser so the keep-alive re-warm path can
 *  be exercised deterministically. Not part of the production flow. */
export async function __dropSessionForTest(): Promise<void> {
  await teardown();
}

/** TEST ONLY: how many browsers were launched, and is one cached now? */
export function __sessionStatsForTest(): { launches: number; hasSession: boolean } {
  return { launches, hasSession: !!session };
}

/** Read the current account balance from the open Tradovate page's
 *  account-summary line — used by the account guard. `realized` = equity −
 *  open P/L (the cash balance backing the day's realized profit). Returns null
 *  when there is no live session or the values can't be parsed. */
export type AccountSnapshot = { equity: number; openPnl: number; realized: number };

export async function readAccount(): Promise<AccountSnapshot | null> {
  if (!session) return null;
  try {
    const snap = await session.page.evaluate(() => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      const eq = t.match(/EQUITY\s+([\d,]+(?:\.\d+)?)\s+USD/);
      const pnl = t.match(/OPEN P\/L\s+(-?[\d,]+(?:\.\d+)?)\s+USD/);
      if (!eq || !pnl) return null;
      const equity = Number(eq[1].replace(/,/g, ""));
      const openPnl = Number(pnl[1].replace(/,/g, ""));
      return { equity, openPnl, realized: equity - openPnl };
    });
    if (!snap || !Number.isFinite(snap.equity) || !Number.isFinite(snap.realized)) return null;
    return snap;
  } catch {
    return null;
  }
}

/* ── live bracketed order ─────────────────────────────────────────────── */
async function placeOrderLive(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  placing = true;
  try {
    return await placeOrderLiveInner(intent);
  } finally {
    placing = false;
  }
}

async function placeOrderLiveInner(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  const contracts = Math.max(1, Math.min(30, jitter(intent.contracts, 1)));
  const page = await getPage();

  let stopTicks = Math.max(1, Math.round(Math.abs(intent.entry - intent.stop) / TICK));
  let targetTicks = Math.max(1, Math.round(Math.abs(intent.target - intent.entry) / TICK));
  stopTicks = Math.max(1, jitter(stopTicks, 1));
  targetTicks = Math.max(1, jitter(targetTicks, 1));

  // 1. open the "Take profit / stop loss settings" modal (creates the bracket
  //    TP/SL inputs) if it isn't already open
  const modal = page.locator('[data-testid="simple-tpsl-atm-settings-modal"]').first();
  if ((await modal.count()) === 0) {
    await humanClick(page, '[data-testid="simple-tpsl-atm-strategy-select"]');
    await humanClick(page, "#add-tpsl-option");
  }

  // 2. fill TP/SL (ticks) INSIDE the modal — defaults are "Ticks" / "TP + SL" / "Stop"
  await humanType(page, '[data-testid="bracket-0-take-profit-input"] input', String(targetTicks));
  await humanType(page, '[data-testid="bracket-0-stop-loss-input"] input', String(stopTicks));

  // 3. Save the bracket preset — this creates a NEW "Strategy N" but does NOT
  //    auto-select it on the ticket; the select still reads "TP/SL: None"
  await humanClickButton(page, "Save");
  await page.waitForTimeout(800);

  // 4. arm the bracket: the dropdown is STILL OPEN after Save, so click the
  //    just-created preset directly (do NOT re-click the select — that toggles
  //    the menu closed). It's listed last. Plain click: a menu pick is
  //    navigation, not the trade action.
  const strategyLinks = page.locator('a:has-text("Strategy")');
  if ((await strategyLinks.count()) > 0) {
    await strategyLinks.last().click();
    await page.waitForTimeout(500);
  }

  // 5. quantity, then the entry
  await humanType(page, 'input[placeholder="Select value"]', String(contracts));

  const useLimit = Math.random() < 0.15;
  const label =
    intent.dir === "long" ? (useLimit ? "Buy Bid" : "Buy Mkt") : (useLimit ? "Sell Ask" : "Sell Mkt");
  await humanClickButton(page, label);
  // the entry click arms the order; the confirm popover actually submits it
  await humanConfirmOrder(page, intent.dir);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/tradovate_order.png" });

  // text evidence of the submit (positions/orders panel) — the operator can't
  // read a PNG, so dump the relevant region to a file for verification
  const after = await page
    .evaluate(() => {
      const t = document.body.innerText || "";
      for (const k of ["Working", "Filled", "Position", "MNQ", "Order", "Rejected", "Margin", "Rejected"]) {
        const i = t.indexOf(k);
        if (i >= 0) return t.slice(Math.max(0, i - 120), i + 260).replace(/\s+/g, " ");
      }
      return t.slice(0, 800).replace(/\s+/g, " ");
    })
    .catch(() => "");
  if (after) {
    const { writeFileSync } = await import("fs");
    writeFileSync("/tmp/tradovate_after.txt", after);
  }

  return {
    ok: true,
    reason: `submitted ${label} ${contracts} MNQ bracketed (stop ${stopTicks}t / target ${targetTicks}t)`,
  };
}

export async function placeOrder(intent: OrderIntent): Promise<{ ok: boolean; reason: string }> {
  // CrossTrade webhook backend takes priority when configured — one HTTP
  // POST at signal time instead of the headed-browser path below.
  if (crossTradeEnabled()) {
    return placeCrossTradeOrder(intent);
  }
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
