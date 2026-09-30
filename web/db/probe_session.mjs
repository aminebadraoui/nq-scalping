/* Probe: after login + Access Simulation, capture any "existing session" /
 * "another session" / resume dialog that intercepts the flow. */
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

  // any dialog / session / resume text right after login?
  console.log("URL after login:", page.url());
  const afterLogin = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  for (const k of ["session", "Session", "resume", "Resume", "continue", "Continue", "another device", "logged in", "close", "Close"]) {
    const i = afterLogin.indexOf(k);
    if (i >= 0) console.log(`[after-login:${k}]`, afterLogin.slice(Math.max(0, i - 120), i + 200));
  }

  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) { await sim.click(); await page.waitForTimeout(6000); }

  console.log("URL after sim:", page.url());
  const body = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  console.log("BODY (first 600):", body.slice(0, 600));

  const dialogs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
      text: (d.innerText || "").replace(/\s+/g, " ").slice(0, 800),
      buttons: Array.from(d.querySelectorAll("button, a")).map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20),
    })),
  );
  console.log("DIALOGS:", JSON.stringify(dialogs, null, 2));
} finally {
  await browser.close();
}
