/* Probe: after Save creates a preset, SELECT it from the dropdown and verify
 * the ticket then shows a bracket. No order placed. */
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

  const sel = page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first();

  // select the most recent strategy preset (they accumulate: Strategy 1..N)
  await sel.click();
  await page.waitForTimeout(1200);
  const items = page.locator('li:has-text("Strategy"), a:has-text("Strategy")');
  const n = await items.count();
  console.log("strategy items:", n);
  if (n > 0) {
    const txt = await items.first().innerText().catch(() => "");
    console.log("first item text:", JSON.stringify(txt));
    await items.first().click();
    await page.waitForTimeout(1500);
  }
  console.log("select after selecting first strategy:", JSON.stringify(await sel.innerText().catch(() => "N/A")));

  // is there now a bracket on the ticket (outside the modal)?
  console.log("bracket inputs on ticket:", await page.locator('[data-testid="bracket-0-take-profit-input"]').count());
  console.log("TP/SL area text:", JSON.stringify((await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().innerText().catch(() => "N/A"))));
} finally {
  await browser.close();
}
