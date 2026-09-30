/* Flatten the open test position (Exit at Mkt) so no naked 1-lot position is
 * left running. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
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
  await page.waitForTimeout(5000);
  if (page.url().includes("current-sessions")) {
    const b = page.locator("button:has-text('Close oldest session and Continue to login'), a:has-text('Close oldest session and Continue to login')").first();
    if (await b.count()) { await b.click(); await page.waitForTimeout(6000); }
  }
  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) { await sim.click(); await page.waitForTimeout(10000); }

  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  const posMatch = body.match(/POSITION\s+(\d+)@([\d.]+)/);
  console.log("position:", posMatch ? posMatch[0] : "none found");

  const exit = page.locator('div:has-text("Exit at Mkt")').first();
  if (await exit.count()) {
    await exit.click();
    await page.waitForTimeout(1500);
    const confirm = page.locator("div.btn").filter({ hasText: /^Sell$/ }).first();
    if (await confirm.count()) { await confirm.click(); await page.waitForTimeout(1500); }
    const body2 = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
    console.log("position after exit:", body2.match(/POSITION\s+\d+@[\d.]+/) ? "STILL OPEN" : "FLAT");
  } else {
    console.log("no Exit button (already flat)");
  }
} finally {
  await browser.close();
}
