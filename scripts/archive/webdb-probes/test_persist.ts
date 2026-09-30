/* Realistic end-to-end test: the executor process stays alive and places TWO
 * orders with a pause between them. The critical assertion is the launch count:
 * it must stay 1 — proving the SAME headed browser stayed open across both
 * orders (login once, reuse the warm session). Two 1-contract bracketed orders
 * are placed and then the position is flattened. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { placeOrder, keepAlive, startKeepAlive, __sessionStatsForTest, executorEnabled } from "../lib/executor";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}

loadEnvLocal();

const timeET = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());

const intent = (dir: "long" | "short") => ({
  symbol: "MNQZ26",
  dir,
  contracts: 1,
  entry: 31000.0,
  stop: 31000.0 - 1.0,
  target: 31000.0 + 1.0,
  timeET: timeET(),
});

console.log("creds:", executorEnabled() ? "ok" : "MISSING", "· EXECUTE_LIVE:", process.env.EXECUTE_LIVE);

// start the keep-alive (logs in immediately — this is the one login for the day)
startKeepAlive(10_000);
await new Promise((r) => setTimeout(r, 2000));
console.log(`[${timeET()}] after warm-up:`, JSON.stringify(__sessionStatsForTest()));

// order 1
const r1 = await placeOrder(intent("long"));
console.log(`[${timeET()}] order 1:`, r1.ok ? r1.reason : "FAIL " + r1.reason);
console.log(`[${timeET()}] after order 1:`, JSON.stringify(__sessionStatsForTest()));

// realistic gap — market running, browser just sitting there (keep-alive ticking every 10s)
console.log(`[${timeET()}] idle 25s — browser should stay open the whole time…`);
await new Promise((r) => setTimeout(r, 25_000));

// order 2 (the moment of truth: same browser, no re-login)
const r2 = await placeOrder(intent("short"));
console.log(`[${timeET()}] order 2:`, r2.ok ? r2.reason : "FAIL " + r2.reason);
console.log(`[${timeET()}] after order 2:`, JSON.stringify(__sessionStatsForTest()));

const stats = __sessionStatsForTest();
console.log("─────────────────────────────────────────────");
console.log(stats.launches === 1 ? "PASS: browser launched ONCE and stayed open across both orders" : `FAIL: browser relaunched ${stats.launches} times (should be 1)`);
console.log("─────────────────────────────────────────────");

// keep the process (and browser) alive so you can see the window is still open
console.log("browser is still open — keeping process alive 60s. Ctrl-C to stop.");
await new Promise((r) => setTimeout(r, 60_000));
