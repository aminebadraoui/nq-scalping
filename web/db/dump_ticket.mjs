/* Log into Tradovate Simulation and dump the FULL order-ticket widget HTML +
 * the context around any bracket/stop/target keywords. Read-only. */
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
  console.log("URL:", page.url());

  // dump the order-ticket widget: the container holding the "Buy Mkt" button
  const ticketHtml = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("div")).find((d) => (d.textContent || "").includes("Buy Mkt") && (d.textContent || "").includes("Sell Mkt"));
    if (!el) return null;
    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) node = node.parentElement;
    return node.outerHTML;
  });
  writeFileSync("/tmp/order_ticket.html", ticketHtml || "");
  console.log("ticket HTML length:", (ticketHtml || "").length);

  const kw = await page.evaluate(() => {
    const body = document.body.innerText;
    const found = {};
    for (const k of ["Bracket", "Stop Loss", "Take Profit", "OCO", "OSO", "Stop", "Target", "Protect", "Attach"]) {
      const idx = body.indexOf(k);
      if (idx >= 0) found[k] = body.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, " ");
    }
    return found;
  });
  console.log("KEYWORD CONTEXTS:", JSON.stringify(kw, null, 2));
} finally {
  await browser.close();
}
