/* Log in, enter Simulation, open the TP/SL dropdown -> "Add take profit / stop
 * loss", and dump the resulting TP/SL price fields. Read-only — no order. */
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
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#name-input", { timeout: 30000 });
  await page.fill("#name-input", env.TRADOVATE_USERNAME);
  await page.fill("#password-input", env.TRADOVATE_PASSWORD);
  await page.click("button:has-text('Login')");
  await page.waitForTimeout(4000);
  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) {
    await sim.click();
    await page.waitForTimeout(10000);
  }

  // open the TP/SL dropdown and pick "Add take profit / stop loss"
  const tpDropdown = page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first();
  if (await tpDropdown.count()) {
    await tpDropdown.click();
    await page.waitForTimeout(1200);
    const add = page.locator("#add-tpsl-option").first();
    if (await add.count()) {
      await add.click();
      console.log("clicked 'Add take profit / stop loss'");
    }
  }
  await page.waitForTimeout(2500);

  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({ placeholder: e.placeholder, value: e.value, type: e.type, id: e.id, testid: e.closest("[data-testid]")?.getAttribute("data-testid") })),
  );
  console.log("INPUTS:", JSON.stringify(inputs, null, 2));

  // save the order-ticket region again for the new TP/SL fields
  const html = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div")).find((d) => (d.textContent || "").includes("Take profit") || (d.textContent || "").includes("Stop loss"));
    if (!el) return null;
    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) node = node.parentElement;
    return node.outerHTML;
  });
  writeFileSync("/tmp/tpsl_fields.html", html || "");
  console.log("saved /tmp/tpsl_fields.html length:", (html || "").length);
} finally {
  await browser.close();
}
