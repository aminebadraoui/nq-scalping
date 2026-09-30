/* Flatten with precise button locator + confirm handling. */
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

  const exitBtn = page.locator('button:has-text("Exit at Mkt")').first();
  console.log("exit btn count:", await exitBtn.count());
  if (await exitBtn.count()) {
    await exitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const box = await exitBtn.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2000);
    // confirm popover
    const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
    console.log("has Sell 1 / Exit confirm:", /Sell 1 MKT|Exit 1|confirm/i.test(body.slice(-600)));
    console.log("tail:", body.slice(-500));
    const confirm = page.locator("div.btn").filter({ hasText: /^Yes$/ }).first();
    if (await confirm.count()) { await confirm.click(); await page.waitForTimeout(1500); }
    const body2 = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
    console.log("after:", body2.match(/POSITION\s+\d+@[\d.]+/) ? "STILL OPEN" : "FLAT");
  }
} finally {
  await browser.close();
}
