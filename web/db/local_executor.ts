/* ------------------------------------------------------------------ *
 * Local executor — run the sweep-reclaim order execution on YOUR Mac.
 *
 * The VPS (Coolify) keeps running the always-on Telegram signal feed; this
 * process is the trading half, running LOCALLY so the Tradovate session uses
 * a HEADED Chromium from a residential IP with humanized input (see
 * lib/executor.ts). It boots its own live GoCharting feed, detects the same
 * sweep-reclaim + one-sided setup the Telegram card announces, and places the
 * bracketed order on the MFF account.
 *
 * Rules (per owner): no signal skipping, no artificial entry delay, no days
 * off. The detection fires the instant the reclaim bar closes and the next
 * minute opens — the earliest it can be known without lookahead.
 *
 * Run from web/:
 *   node --import ./tests/ts-loader.mjs db/local_executor.ts
 *
 * Env (web/.env.local, gitignored):
 *   TRADOVATE_USERNAME / TRADOVATE_PASSWORD   required
 *   EXECUTE_LIVE=1                            place real orders (else dry-run)
 *   PROP_RISK_PER_TRADE=170                   $ risk per trade
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
import { contractsForRisk } from "../lib/propRules";
import { placeOrder, executorEnabled, startKeepAlive } from "../lib/executor";

/* load web/.env.local into process.env (gitignored) — Tradovate creds, EXECUTE_LIVE */
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
const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || 170;
const symbol = () => process.env.GOCHARTING_SYMBOL || "NQZ26";
const fired = new Set<string>();

function check() {
  const state = live.state;
  if (!state.connected || state.minutes.length < 3) return;
  const setup = detectOneSidedReclaim(liveMinutesToFootprint(state.minutes));
  if (!setup) return;
  const key = `${setup.day}|${setup.dir}|${setup.t}`;
  if (fired.has(key)) return;
  fired.add(key);
  if (fired.size > 500) fired.delete([...fired][0]);

  const contracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, setup.risk)));
  void placeOrder({
    symbol: symbol(),
    dir: setup.dir,
    contracts,
    entry: setup.entry,
    stop: setup.stop,
    target: setup.target,
    timeET: setup.timeET,
  }).then((r) => console.log(`[executor] ${setup.dir.toUpperCase()} @ ${setup.timeET} → ${r.ok ? r.reason : "FAILED: " + r.reason}`));
}

console.log(`[local-executor] started — ${executorEnabled() ? (process.env.EXECUTE_LIVE === "1" ? "LIVE (headed, humanized)" : "DRY-RUN (headed)") : "NO TRADOVATE CREDS"}`);
console.log(`[local-executor] watching ${symbol()} for sweep-reclaim · risk $${riskPerTrade} · poll ${POLL_MS}ms`);

// keep the Tradovate session warm all day: re-login silently if it drops, so a
// signal never waits on the ~20s login sequence
startKeepAlive(60_000);

setInterval(check, POLL_MS);
check();
