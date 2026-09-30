/* Full executor flow, but after clicking the entry button dump EVERYTHING —
 * specifically hunting for a confirmation/place-order dialog. */
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
  console.log("URL after sim:", page.url());

  // open bracket modal
  await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().click();
  await page.waitForTimeout(1200);
  await page.locator("#add-tpsl-option").first().click();
  await page.waitForTimeout(1500);
  console.log("modal open:", await page.locator('[data-testid="simple-tpsl-atm-settings-modal"]').count());

  // fill TP/SL
  await page.locator('[data-testid="bracket-0-take-profit-input"] input').first().fill("4");
  await page.locator('[data-testid="bracket-0-stop-loss-input"] input').first().fill("4");
  await page.waitForTimeout(400);
  console.log("SL/TP values:", await page.locator('[data-testid="bracket-0-stop-loss-input"] input').first().inputValue(), await page.locator('[data-testid="bracket-0-take-profit-input"] input').first().inputValue());

  // Save
  await page.getByText("Save", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  console.log("after Save — modal count:", await page.locator('[data-testid="simple-tpsl-atm-settings-modal"]').count());
  const tpslText = await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().innerText().catch(() => "N/A");
  console.log("TP/SL select after save:", JSON.stringify(tpslText));

  // quantity
  await page.locator('input[placeholder="Select value"]').first().click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("1", { delay: 60 });
  await page.waitForTimeout(400);
  console.log("qty value:", await page.locator('input[placeholder="Select value"]').first().inputValue());

  // entry
  const buy = page.getByText("Buy Mkt", { exact: true }).first();
  await buy.scrollIntoViewIfNeeded().catch(() => {});
  const box = await buy.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(2500);

  const dialogs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
      text: (d.innerText || "").replace(/\s+/g, " ").slice(0, 600),
      buttons: Array.from(d.querySelectorAll("button, a")).map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20),
    })),
  );
  console.log("DIALOGS after entry:", JSON.stringify(dialogs, null, 2));

  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  console.log("has 'Working':", /Working/.test(body), "has 'confirm':", /confirm|are you sure|place order|submit/i.test(body));
  console.log("BODY tail:", body.slice(-1200));
  await page.screenshot({ path: "/tmp/diag_entry.png" });
} finally {
  await browser.close();
}
