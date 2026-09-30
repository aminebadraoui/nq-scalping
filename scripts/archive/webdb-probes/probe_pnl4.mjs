/* Find the account-summary widget and dump its label→value pairs in order. */
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
  for (let i = 0; i < 20; i++) { try { await page.waitForSelector("#name-input", { state: "visible", timeout: 3000 }); break; } catch {} await new Promise(r => setTimeout(r, 500)); }
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

  // find the element containing the account number, walk up to its summary widget, dump ordered text nodes
  const info = await page.evaluate(() => {
    const acct = "MFFUEVREOD706880005";
    let el = null;
    for (const d of document.querySelectorAll("div, span")) {
      if ((d.textContent || "").includes(acct) && (d.textContent || "").length < 400) { el = d; break; }
    }
    if (!el) return null;
    // climb to a container that also mentions "EQUITY" or "Margin" (the summary widget)
    let node = el;
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const t = (node.textContent || "").replace(/\s+/g, " ");
      if (t.includes("EQUITY") || (t.includes("Margin") && t.includes("P/L"))) break;
    }
    // ordered leaf text nodes with their nearest preceding label
    const leaves = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = c.textContent.trim();
          if (t) leaves.push({ type: "text", v: t });
        } else if (c.nodeType === 1) {
          const txt = c.textContent.trim();
          // if element has a single text child, treat as one leaf
          if (c.childNodes.length === 1 && c.childNodes[0].nodeType === 3) leaves.push({ type: c.tagName, v: txt });
          else walk(c);
        }
      }
    };
    walk(node);
    return { html: node.outerHTML.slice(0, 5000), leaves: leaves.map((l) => l.v).slice(0, 60) };
  });
  console.log("LEAVES (ordered):", JSON.stringify(info?.leaves, null, 1));
  console.log("\nHTML:\n", info?.html);
} finally {
  await browser.close();
}
