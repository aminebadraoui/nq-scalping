/* ------------------------------------------------------------------ *
 * Local executor — run the sweep-reclaim order execution on YOUR Mac
 * through the CrossTrade backend.
 *
 * The VPS (Coolify) keeps running the always-on Telegram signal feed; this
 * process is the trading half. It boots its own live GoCharting feed, detects
 * the same sweep-reclaim + one-sided setup the Telegram card announces, and
 * places the bracketed order on the MFF account via CrossTrade (REST absolute
 * brackets by default — see lib/crossTrade.ts).
 *
 * Rules (per owner): no signal skipping, no artificial entry delay, no days
 * off — inside the signal window (Sunday 18:00 ET → Friday 16:00 ET with a
 * daily 16:00–18:00 ET halt, lib/marketHours.ts). Outside the window
 * detection is idled: MyFundedFutures rejects entries there. The detection
 * fires the instant the reclaim bar closes and the next minute opens — the
 * earliest it can be known without lookahead.
 *
 * Run from web/:
 *   node --import ./tests/ts-loader.mjs db/local_executor.ts
 *
 * Env (web/.env.local, gitignored):
 *   CROSSTRADE_URL / CROSSTRADE_KEY / CROSSTRADE_ACCOUNT   required
 *   EXECUTE_LIVE=1                            place real orders (else dry-run)
 *   PROP_RISK_PER_TRADE=100                   $ risk per trade (lib/propRules.ts PROP_RISK_PER_TRADE)
 *   GOCHARTING_*                              from ../gcdata/.env (live feed)
 *
 * Keep EXECUTE_LIVE=0 on the VPS — the Telegram feed must only ANNOUNCE, never
 * double-execute; this local process is the single order source.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getLive } from "../lib/live";
import { liveMinutesToFootprint } from "../lib/signalEngine";
import { detectOneSidedReclaim } from "../lib/reclaimSetup";
import { contractsForRisk, PROP_RISK_PER_TRADE } from "../lib/propRules";
import { placeOrder } from "../lib/executor";
import { crossGuardGate } from "../lib/crossGuard";
import { crossTradeEnabled } from "../lib/crossTrade";
import { guardState } from "../lib/accountGuard";
import { signalWindowOpen } from "../lib/marketHours";

/* load web/.env.local into process.env (gitignored) — CrossTrade creds, EXECUTE_LIVE */
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
  } catch {
    /* no .env.local */
  }
}

loadEnvLocal();

const POLL_MS = 5000;
const live = getLive();
const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
const symbol = () => process.env.GOCHARTING_SYMBOL || "NQZ26";
const fired = new Set<string>();
/** window state for the transition logs (log once per open/close) */
let windowOpen = true;

function check() {
  const state = live.state;
  // signal window (owner rule): Sunday 18:00 ET → Friday 16:00 ET with a
  // daily 16:00–18:00 ET halt — MyFundedFutures rejects entries outside it,
  // so detection is idled too.
  if (!signalWindowOpen(Date.now())) {
    if (windowOpen) {
      windowOpen = false;
      console.log("[local-executor] signal window closed — Sunday 18:00 → Friday 16:00 NY · daily 16:00–18:00 halt · idling until reopen");
    }
    return;
  }
  if (!windowOpen) {
    windowOpen = true;
    console.log("[local-executor] signal window open — watching");
  }
  if (!state.connected || state.minutes.length < 3) return;
  const setup = detectOneSidedReclaim(liveMinutesToFootprint(state.minutes));
  if (!setup) return;
  const key = `${setup.day}|${setup.dir}|${setup.t}`;
  if (fired.has(key)) return;
  fired.add(key);
  if (fired.size > 500) fired.delete([...fired][0]);

  // account guard: the MFF Rapid EOD 50k limits (EOD-trailing max loss, profit
  // target, funded T1-news ban) read from the CrossTrade account snapshot. A
  // breach of these fails the account, so it takes precedence over "never skip
  // a signal".
  void (async () => {
    const g = await crossGuardGate();
    if (g.verdict !== "ok") {
      console.log(`[guard] BLOCKED ${setup.dir.toUpperCase()} @ ${setup.timeET} — ${g.reason}`);
      return;
    }
    const contracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, setup.risk)));
    const r = await placeOrder({
      symbol: symbol(),
      dir: setup.dir,
      contracts,
      entry: setup.entry,
      stop: setup.stop,
      target: setup.target,
      timeET: setup.timeET,
    });
    console.log(`[executor] ${setup.dir.toUpperCase()} @ ${setup.timeET} → ${r.ok ? r.reason : "FAILED: " + r.reason}`);
  })();
}

console.log(`[local-executor] started — ${crossTradeEnabled() ? (process.env.EXECUTE_LIVE === "1" ? "LIVE (CrossTrade)" : "DRY-RUN (CrossTrade)") : "NO CROSSTRADE CREDS"}`);
console.log(`[local-executor] watching ${symbol()} for sweep-reclaim · risk $${riskPerTrade} · poll ${POLL_MS}ms`);
console.log(`[guard] ${JSON.stringify(guardState())}`);

setInterval(check, POLL_MS);
check();
