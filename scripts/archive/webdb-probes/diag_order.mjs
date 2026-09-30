/* Diagnostic: log in, set up the ticket exactly like the executor, click Buy
 * Mkt, then dump EVERYTHING — confirm dialogs, toasts, errors, order rows. */
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

  // what does the TP/SL dropdown currently read?
  const tpslText = await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().innerText().catch(() => "N/A");
  console.log("TP/SL select text:", JSON.stringify(tpslText));

  // is the bracket visible right now?
  const tpInput = page.locator('[data-testid="bracket-0-take-profit-input"] input');
  console.log("tp input count:", await tpInput.count(), "visible:", await tpInput.first().isVisible().catch(() => false));

  // open the TP/SL dropdown and add the bracket (mirror the executor)
  await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().click();
  await page.waitForTimeout(1200);
  const add = page.locator("#add-tpsl-option").first();
  console.log("#add-tpsl-option count:", await add.count());
  if (await add.count()) { await add.click(); await page.waitForTimeout(1500); }
  console.log("TP/SL select text after add:", JSON.stringify(await page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first().innerText().catch(() => "N/A")));

  // fill quantity + brackets
  const q = page.locator('input[placeholder="Select value"]').first();
  console.log("qty input count:", await q.count());
  await q.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("1", { delay: 60 });
  await page.waitForTimeout(300);

  const sl = page.locator('[data-testid="bracket-0-stop-loss-input"] input').first();
  const tp = page.locator('[data-testid="bracket-0-take-profit-input"] input').first();
  console.log("sl visible:", await sl.isVisible().catch(() => false), "tp visible:", await tp.isVisible().catch(() => false));
  for (const [name, el] of [["SL", sl], ["TP", tp]]) {
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("4", { delay: 60 });
      await page.waitForTimeout(300);
    }
  }
  console.log("SL value:", await sl.inputValue().catch(() => "N/A"), "TP value:", await tp.inputValue().catch(() => "N/A"));

  // click Buy Mkt (exact text)
  const buy = page.getByText("Buy Mkt", { exact: true }).first();
  console.log("Buy Mkt count:", await buy.count());
  await buy.scrollIntoViewIfNeeded().catch(() => {});
  const box = await buy.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(3000);

  // dump: dialogs, toasts, body tail
  const state = await page.evaluate(() => {
    const body = (document.body.innerText || "").replace(/\s+/g, " ");
    const out = { tail: body.slice(-1500), hasConfirm: /confirm|are you sure|place order|submit/i.test(body), hasToast: /rejected|error|invalid|margin/i.test(body.slice(-800)) };
    return out;
  });
  console.log("hasConfirm:", state.hasConfirm, "hasToast:", state.hasToast);
  console.log("BODY TAIL:\n", state.tail);
  await page.screenshot({ path: "/tmp/diag_after.png", fullPage: false });
} finally {
  await browser.close();
}
