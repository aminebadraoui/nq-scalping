/* Test the keep-alive: (1) first call warms the session (login), (2) a second
 * call is a no-op while warm, (3) after the browser is dropped, the next call
 * re-warms it. No order is placed. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { keepAlive, __dropSessionForTest, executorEnabled } from "../lib/executor";

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

console.log("creds:", executorEnabled() ? "ok" : "MISSING");
console.log("EXECUTE_LIVE:", process.env.EXECUTE_LIVE);

// 1. warm (should log "session re-warmed")
console.log("--- step 1: first keepAlive (should login) ---");
await keepAlive();

// 2. warm no-op (should print nothing — session already alive)
console.log("--- step 2: second keepAlive (should be silent no-op) ---");
await keepAlive();

// 3. drop the browser, then re-warm
console.log("--- step 3: drop session ---");
await __dropSessionForTest();

console.log("--- step 4: keepAlive after drop (should re-warm) ---");
await keepAlive();

console.log("done");
