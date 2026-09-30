/* Re-open the still-warm Tradovate session and dump the newest orders/positions
 * rows so we can confirm the 1-contract test order actually landed. */
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
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = "/Users/amean/PROJECTS/DEV/Scalping/.playwright-browsers";

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

  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  writeFileSync("/tmp/tradovate_full.txt", body);

  // pull the order-history rows + any position row
  const snippets = [];
  for (const k of ["1 MNQ", "MNQZ6", "Working", "Filled", "Position", "Bracket", "OCO"]) {
    let from = 0;
    let n = 0;
    while (n < 4) {
      const i = body.indexOf(k, from);
      if (i < 0) break;
      snippets.push(`[${k}] ` + body.slice(Math.max(0, i - 90), i + 200));
      from = i + 1;
      n++;
    }
  }
  console.log(snippets.slice(0, 30).join("\n\n"));
} finally {
  await browser.close();
}
