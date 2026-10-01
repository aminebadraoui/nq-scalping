/* Read-only Tradovate inspector: log in via the web UI (same flow as the
 * executor), grab the session token, and pull the user's orders/fills to
 * reconstruct the morning trade. NEVER places or modifies anything. */
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8");
const USER = env.match(/TRADOVATE_USERNAME=(\S+)/)?.[1] ?? "";
const PWD = env.match(/TRADOVATE_PASSWORD=(\S+)/)?.[1] ?? "";
if (!USER || !PWD) {
  console.error("creds missing");
  process.exit(1);
}

const API = "https://live-api.tradovate.com/v1";

async function api<T>(path: string, token: string, body?: unknown): Promise<T | null> {
  const r = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`api ${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return null;
  }
  return (await r.json()) as T;
}

async function main() {
  process.env.PLAYWRIGHT_BROWSERS_PATH =
    process.env.PLAYWRIGHT_BROWSERS_PATH || "/Users/amean/PROJECTS/DEV/Scalping/.playwright-browsers";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: "America/New_York" });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();

  console.log("opening trader.tradovate.com…");
  await page.goto("https://trader.tradovate.com", { waitUntil: "domcontentloaded", timeout: 60_000 });
  for (let tries = 0; tries < 12; tries++) {
    try {
      await page.waitForSelector("#name-input", { state: "attached", timeout: 3000 });
      break;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  await page.fill("#name-input", USER).catch(() => {});
  await page.fill("#password-input", PWD).catch(() => {});
  await page.click("button:has-text('Login')").catch(() => {});
  await page.waitForTimeout(5000);

  if (page.url().includes("current-sessions")) {
    const btn = page.locator("button:has-text('Close oldest session'), a:has-text('Close oldest session')").first();
    if (await btn.count()) {
      await btn.click();
      await page.waitForTimeout(6000);
    }
  }
  const sim = page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if (await sim.count()) {
    await sim.click();
    await page.waitForTimeout(10_000);
  }

  await page.waitForTimeout(4000);
  console.log("URL:", page.url());

  const ls = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      out[k] = (localStorage.getItem(k) ?? "").slice(0, 80);
    }
    return out;
  });
  console.log("localStorage keys:", JSON.stringify(ls, null, 1).slice(0, 800));
  const token = await page.evaluate(() => localStorage.getItem("accessToken"));
  console.log("token captured:", token ? "yes" : "NO — localStorage empty");
  if (!token) {
    console.log("(no REST token — scraping the Orders panel)");
    await page.waitForTimeout(8000);
    // the orders panel table rows
    const rows = await page.evaluate(() => {
      const out: string[] = [];
      const tables = document.querySelectorAll("table, [role='table'], [class*='table']");
      for (const t of tables) {
        const txt = (t as HTMLElement).innerText;
        if (txt.includes("ORDER QTY")) {
          for (const tr of t.querySelectorAll("tr, [role='row']")) {
            const r = (tr as HTMLElement).innerText.replace(/\n/g, " | ");
            if (r.trim() && !r.includes("ORDER QTY")) out.push(r);
          }
        }
      }
      return out;
    });
    console.log("order rows:", rows.length);
    for (const r of rows) console.log("ROW:", r.slice(0, 220));
    await browser.close();
    process.exit(0);
  }

  const me = await api<Record<string, unknown>>("/auth/me", token);
  console.log("auth/me:", JSON.stringify(me)?.slice(0, 200));

  const accts = await api<Record<string, unknown>[]>("/account/list", token);
  const accountId = accts?.[0]?.id as number | undefined;
  console.log("accounts:", JSON.stringify(accts?.map((a) => ({ id: a.id, name: a.name, status: a.accountStatus, netLiq: a.netLiq, realized: a.realizedPnL }))));

  if (!accountId) {
    await browser.close();
    process.exit(1);
  }

  const orders = await api<Record<string, unknown>[]>("/order/list", token, { masterids: [accountId] });
  console.log(`\n== orders (${orders?.length ?? 0}) ==`);
  for (const o of orders ?? []) {
    console.log(
      `#${o.id} ${o.action} ${o.orderQty} ${o.contractName ?? (o as any).contract} @ ${o.orderType} ${o.limitPrice ?? o.stopPrice ?? ""} status=${o.ordStatus} oco=${o.ocoId ?? "-"} t=${(o as any).timestamp?.processed ?? ""}`
    );
  }

  const fills = await api<Record<string, unknown>[]>("/fill/list", token, { masterids: [accountId] });
  console.log(`\n== fills (${fills?.length ?? 0}) ==`);
  for (const f of (fills ?? []).slice(-30)) {
    console.log(`${f.timestamp} ${f.action} ${f.qty} @ ${f.price} orderId=${f.orderId}`);
  }

  const pos = await api<Record<string, unknown>[]>("/position/list", token, { accountIds: [accountId] });
  console.log("\n== positions ==", JSON.stringify(pos));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
