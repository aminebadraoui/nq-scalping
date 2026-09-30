/* Probe: after clicking "Add take profit / stop loss", dump the modal that
 * appears so we can find its confirm/close buttons. */
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function loadEnv() {
  const env = {};
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  } catch {}
  return env;
}

const env = loadEnv();
const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  const page = await ctx.newPage();
  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#name-input", { timeout: 30000 });
  await page.fill("#name-input", env.TRADOVATE_USERNAME);
  await page.fill("#password-input", env.TRADOVATE_PASSWORD);
  await page.click("button:has-text('Login')");
  await page.waitForTimeout(4000);
  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) { await sim.click(); await page.waitForTimeout(10000); }

  await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().click();
  await page.waitForTimeout(1200);
  await page.locator("#add-tpsl-option").first().click();
  await page.waitForTimeout(2000);

  // dump every dialog's buttons + visible text
  const dialogs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
      text: (d.innerText || "").replace(/\s+/g, " ").slice(0, 1200),
      buttons: Array.from(d.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 30),
      testids: Array.from(d.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")).slice(0, 40),
    }));
  });
  console.log(JSON.stringify(dialogs, null, 2));

  // also: is the bracket input now present behind the modal?
  console.log("tp input count:", await page.locator('[data-testid="bracket-0-take-profit-input"] input').count());
} finally {
  await browser.close();
}
