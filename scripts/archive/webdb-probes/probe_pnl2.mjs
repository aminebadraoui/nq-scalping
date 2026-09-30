/* Dump the account-summary bar's HTML structure to identify the label that
 * sits next to the "749.80" figure (candidate: day realized P/L). */
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

  // find the element whose text is exactly the account summary and dump its
  // innerHTML (so labels + values are visible in order)
  const html = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("div"));
    // the account bar contains both "EQUITY" and "Open P/L"
    for (const el of els) {
      const t = (el.innerText || "").replace(/\s+/g, " ");
      if (t.includes("EQUITY") && t.includes("Open P/L") && t.length < 400) {
        return el.outerHTML;
      }
    }
    return null;
  });
  console.log("ACCOUNT BAR HTML:\n", html ? html.slice(0, 4000) : "NOT FOUND");
} finally {
  await browser.close();
}
