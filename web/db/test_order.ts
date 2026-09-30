/* One-shot LOCAL test of the humanized executor: log in, enter Simulation,
 * and submit ONE 1-contract MNQ bracketed order (long, market) so we can
 * verify the whole flow + eyeball the resulting text dump. RUN ONLY AFTER
 * manually confirming you're OK placing a real (simulated) order. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { placeOrder } from "../lib/executor";

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

// a synthetic long intent: 1 contract, realistic MNQ prices, 1.00 pt risk
const intent = {
  symbol: "MNQZ26",
  dir: "long" as const,
  contracts: 1,
  entry: 31000.0,
  stop: 31000.0 - 1.0, // 1.00 pt below = 4 ticks
  target: 31000.0 + 1.0, // 1.00 pt above = 4 ticks
  timeET: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()),
};

const res = await placeOrder(intent);
console.log("RESULT:", JSON.stringify(res));
process.exit(res.ok ? 0 : 1);
