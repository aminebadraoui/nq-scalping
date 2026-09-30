/* One-off: open trader.tradovate.com headless, dump the login + order-ticket
 * DOM so the executor can target real selectors. Read-only — never submits an
 * order. Run: node ./db/dump_tradovate.mjs */
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
const USER = env.TRADOVATE_USERNAME;
const PASS = env.TRADOVATE_PASSWORD;
console.log("creds:", USER ? `${USER.slice(0, 6)}…` : "MISSING", PASS ? "password present" : "MISSING");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log("URL:", page.url());
  console.log("TITLE:", await page.title());

  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder, aria: e.getAttribute("aria-label") })),
  );
  console.log("INPUTS:", JSON.stringify(inputs, null, 2));

  const authButtons = await page.$$eval("button, a", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t && /login|sign ?in|log ?in/i.test(t)).slice(0, 20),
  );
  console.log("AUTH BUTTONS:", JSON.stringify(authButtons));

  const bodyText = await page.$$eval("body", (els) => (els[0]?.innerText || "").slice(0, 1500));
  console.log("BODY TEXT (first 1500):\n", bodyText);

  await page.screenshot({ path: "/tmp/tradovate.png", fullPage: true });
  writeFileSync("/tmp/tradovate.html", await page.content());
  console.log("\nsaved /tmp/tradovate.png + /tmp/tradovate.html");
} finally {
  await browser.close();
}
