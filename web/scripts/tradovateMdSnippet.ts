/* ------------------------------------------------------------------ *
 * Generate the paste-ready browser-relay snippet for the Tradovate md
 * collector. Reads TVMD_* config (env vars / web/.env.local), inlines
 * the token, symbols, hosts, and subscriptions into
 * scripts/tradovateMdPage.js, and prints one block to paste into the
 * DevTools console of the logged-in trader.tradovate.com page.
 *
 * Usage (from web/):
 *   node --import ../scripts/ts-loader.mjs ./scripts/tradovateMdSnippet.ts
 *
 * The sink must already be running in another terminal:
 *   TVMD_TRANSPORT=http node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";

// same .env.local convention as scripts/importTradovateTrades.ts
function loadDotEnv(): void {
  try {
    const envFile = readFileSync(".env.local", "utf8");
    for (const line of envFile.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const key = s.slice(0, i).trim();
      if (!process.env[key]) process.env[key] = s.slice(i + 1).trim();
    }
  } catch {
    /* no .env.local — env vars only */
  }
}

loadDotEnv();

const env = process.env.TVMD_ENV === "demo" ? "demo" : "live";
const HOSTS = {
  live: { md: "wss://md.tradovateapi.com/v1/websocket", trade: "wss://live.tradovateapi.com/v1/websocket" },
  demo: { md: "wss://md-demo.tradovateapi.com/v1/websocket", trade: "wss://demo.tradovateapi.com/v1/websocket" },
} as const;

const token = (process.env.TVMD_TOKEN ?? "").trim();
const symbols = (process.env.TVMD_SYMBOLS ?? "MNQZ6").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const mdHost = process.env.TVMD_MD_HOST ?? HOSTS[env].md;
const tradeHost = process.env.TVMD_TRADE_HOST ?? HOSTS[env].trade;
const subsRaw = (process.env.TVMD_SUBS ?? "quote,dom,hist,chart").toLowerCase();
const subs = { quote: false, dom: false, hist: false, chart: false };
for (const part of subsRaw.split(",")) {
  const s = part.trim();
  if (s === "quote" || s === "dom" || s === "hist" || s === "chart") subs[s] = true;
}
const chartElements = Number(process.env.TVMD_CHART_ELEMENTS ?? 10) || 10;
const sinkPort = Number(process.env.TVMD_SINK_PORT ?? 3777) || 3777;

let page = readFileSync("./scripts/tradovateMdPage.js", "utf8");
page = page
  .replace("__TVMD_TOKEN__", JSON.stringify(token))
  .replace("__TVMD_SYMBOLS__", JSON.stringify(symbols))
  .replace("__TVMD_MD_HOST__", mdHost)
  .replace("__TVMD_TRADE_HOST__", tradeHost)
  .replace("__TVMD_SUBS__", JSON.stringify(subs))
  .replace("__TVMD_CHART_ELEMENTS__", String(chartElements))
  .replace("__TVMD_SINK__", `http://127.0.0.1:${sinkPort}`);

console.error("/* ---------------------------------------------------------------- */");
console.error(
  `  tvmd snippet — env=${env} symbols=${symbols.join(",")} subs=${Object.keys(subs).filter((k) => subs[k as keyof typeof subs]).join(",")} sink=http://127.0.0.1:${sinkPort}`,
);
if (!token)
  console.error(
    "  WARNING: no TVMD_TOKEN set — the snippet will try to read a token from localStorage; re-capture first if that fails",
  );
console.error("  Paste this into the DevTools console of the logged-in trader.tradovate.com page, then keep the tab open.");
console.error("/* ---------------------------------------------------------------- */");
console.log(page);
