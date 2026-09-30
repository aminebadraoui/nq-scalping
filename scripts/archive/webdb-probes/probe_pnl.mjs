/* Probe: find a DAY realized P&L figure (not just equity) in the Tradovate
 * dashboard DOM, for the consistency guard. */
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
  console.log("FULL BODY (first 1600):\n", body.slice(0, 1600));

  // look for any day-PL / realized / net labels anywhere
  for (const k of ["DAY P/L", "REALIZED", "NET P/L", "DAY PL", "DAY NET", "GROSS", "TOTAL P/L", "CLOSED", "DAILY", "PROFIT/LOSS", "P/L TODAY", "TODAY"]) {
    let i = body.indexOf(k);
    let n = 0;
    while (i >= 0 && n < 2) {
      console.log(`[${k}]`, body.slice(Math.max(0, i - 60), i + 140));
      i = body.indexOf(k, i + 1);
      n++;
    }
  }

  // dump all elements whose text looks like a dollar P/L (negative or positive $)
  const moneyTexts = await page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll("div, span, td")) {
      const t = (el.textContent || "").trim();
      if (/\$?[-+]?\d[\d,]*\.\d{2}\s*(USD)?/.test(t) && t.length < 40) out.add(t);
    }
    return Array.from(out).slice(0, 60);
  });
  console.log("MONEY-LOOKING NODES:", JSON.stringify(moneyTexts, null, 2));
} finally {
  await browser.close();
}
