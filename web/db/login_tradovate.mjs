/* Log into Tradovate headless, enter Simulation mode, and dump the trading
 * dashboard DOM (order-ticket selectors). Read-only — places no order. */
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

  // enter Simulation (the MFF eval/funded environment)
  const simBtn = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await simBtn.count()) {
    await simBtn.click();
    console.log("entered Simulation mode");
  }
  await page.waitForTimeout(12000);

  console.log("URL:", page.url());
  console.log("TITLE:", await page.title());

  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({ type: e.type, id: e.id, name: e.name, placeholder: e.placeholder, aria: e.getAttribute("aria-label"), cls: e.className?.slice?.(0, 60) })).slice(0, 60),
  );
  console.log("INPUTS:", JSON.stringify(inputs, null, 2));

  const btns = await page.$$eval("button", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t && t.length < 40).slice(0, 80),
  );
  console.log("BUTTONS:", JSON.stringify(btns));

  const bodyText = await page.$$eval("body", (els) => (els[0]?.innerText || "").slice(0, 2500));
  console.log("BODY TEXT (first 2500):\n", bodyText);

  await page.screenshot({ path: "/tmp/tradovate_sim.png", fullPage: true });
  writeFileSync("/tmp/tradovate_sim.html", await page.content());
  console.log("\nsaved /tmp/tradovate_sim.png + /tmp/tradovate_sim.html");
} finally {
  await browser.close();
}
