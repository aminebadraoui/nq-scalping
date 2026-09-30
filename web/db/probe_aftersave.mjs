/* After Save, dump the state: is there a backdrop/overlay? where is the select?
 * is it clickable? */
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
  await sel.click();
  await page.waitForTimeout(1000);
  await page.locator("#add-tpsl-option").first().click();
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="bracket-0-take-profit-input"] input').first().fill("4");
  await page.locator('[data-testid="bracket-0-stop-loss-input"] input').first().fill("4");
  await page.getByText("Save", { exact: true }).first().click();
  await page.waitForTimeout(2000);

  // modal gone?
  console.log("modal count after save:", await page.locator('[data-testid="simple-tpsl-atm-settings-modal"]').count());
  // select state
  const selInfo = await sel.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 && r.height > 0, text: e.innerText };
  });
  console.log("select info:", JSON.stringify(selInfo));
  // any overlay/backdrop?
  const overlays = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".modal-backdrop, .fade.in, [role='presentation']")) {
      const r = el.getBoundingClientRect();
      out.push({ cls: (el.className || "").toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  });
  console.log("overlays:", JSON.stringify(overlays));
  await page.screenshot({ path: "/tmp/after_save.png" });
} finally {
  await browser.close();
}
