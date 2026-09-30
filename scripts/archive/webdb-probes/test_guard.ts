/* Integration test: log in, read the LIVE account equity from the open
 * Tradovate page, and run it through the account guard — no order placed. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { keepAlive, readAccount, executorEnabled } from "../lib/executor";
import { guardCheck, guardState } from "../lib/accountGuard";

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

console.log("creds:", executorEnabled() ? "ok" : "MISSING", "· stage:", process.env.MFF_STAGE || "eval (default)");

// warm the session (login) — this is what the long-running executor does once
console.log("--- warming session (login) ---");
await keepAlive();

// read live account snapshot
const snap = await readAccount();
console.log(
  "live account:",
  snap === null
    ? "UNREADABLE"
    : `equity $${snap.equity.toFixed(2)} · open P/L $${snap.openPnl.toFixed(2)} · realized $${snap.realized.toFixed(2)}`,
);

// run it through the guard
const decision = guardCheck(snap);
console.log("guard decision:", JSON.stringify(decision));
console.log("guard state  :", JSON.stringify(guardState()));

console.log("─────────────────────────────────────────────");
console.log(decision.verdict === "ok" ? "PASS: guard allows trading (equity above floor, below target)" : `RESULT: ${decision.verdict}`);
console.log("─────────────────────────────────────────────");

// leave the browser open a moment so you can see the window is alive
console.log("keeping the session open 10s — the browser window stays up.");
await new Promise((r) => setTimeout(r, 10_000));
