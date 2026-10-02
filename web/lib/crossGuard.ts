/* ------------------------------------------------------------------ *
 * CrossTrade account guard — the MFF Rapid EOD 50k guard with a
 * server-side data source instead of the browser page.
 *
 * The browser path read equity/realized from the open Tradovate page;
 * the CrossTrade webhook path trades without any page. This module
 * feeds the SAME pure guard (lib/accountGuard.ts — floor, target,
 * consistency, news rules) from the CrossTrade account snapshot
 * (GET /v1/api/tv/accounts/snapshot): netLiq → equity, realizedPnl →
 * realized. Snapshot cached ~30s; a failed read halts (fail closed).
 *
 * Bootstrap: the guard state file is ephemeral on the VPS container, so
 * on first load with no persisted state the floor is re-derived from the
 * LIVE equity (equity − maxLoss), never from a stale seed.
 * ------------------------------------------------------------------ */

import { existsSync } from "fs";
import path from "path";
import { guardCheck, guardState, hydrateGuardFromDb, tradingDayKey, type GuardDecision } from "./accountGuard";

type Snapshot = { equity: number; realized: number };

let cache: { at: number; snap: Snapshot | null } | null = null;
const CACHE_MS = 30_000;

function enabled(): boolean {
  return !!process.env.CROSSTRADE_URL && !!process.env.CROSSTRADE_KEY && !!process.env.CROSSTRADE_ACCOUNT;
}

async function fetchSnapshot(): Promise<Snapshot | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.snap;
  const key = process.env.CROSSTRADE_KEY ?? "";
  try {
    const res = await fetch("https://app.crosstrade.io/v1/api/tv/accounts/snapshot", {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      cache = { at: Date.now(), snap: null };
      return null;
    }
    const j = (await res.json()) as {
      accounts?: Array<{ name: string; netLiq?: number; realizedPnl?: number }>;
    };
    const acct = (j.accounts ?? []).find(
      (a) => a.name?.toUpperCase() === (process.env.CROSSTRADE_ACCOUNT ?? "").toUpperCase(),
    );
    const snap: Snapshot | null =
      acct && Number.isFinite(acct.netLiq) && Number.isFinite(acct.realizedPnl)
        ? { equity: Number(acct.netLiq), realized: Number(acct.realizedPnl) }
        : null;
    cache = { at: Date.now(), snap };
    return snap;
  } catch {
    cache = { at: Date.now(), snap: null };
    return null;
  }
}

let bootstrapped = false;
function bootstrap(snap: Snapshot) {
  if (bootstrapped) return;
  const stateFile = path.join(process.cwd(), ".executor-guard.json");
  if (existsSync(stateFile)) {
    bootstrapped = true;
    return;
  }
  // no persisted state (fresh container): trail from the live equity
  const s = guardState();
  const candidate = snap.equity - s.maxLoss;
  if (candidate > s.floor) s.floor = candidate;
  if (snap.equity > s.highWater) s.highWater = snap.equity;
  bootstrapped = true;
}

/** the entry gate: call before any order. Halts on guard breach or
 *  unreadable account (fail closed); no-ops when CrossTrade is off. */
export async function crossGuardGate(): Promise<GuardDecision> {
  if (!enabled()) return { verdict: "ok", reason: "crossGuard: CrossTrade not configured" };
  const snap = await fetchSnapshot();
  if (!snap) return { verdict: "no-data", reason: "crossGuard: account snapshot unreadable — halting" };
  bootstrap(snap);
  await hydrateGuardFromDb(); // restore the persisted floor/day counter (redeploy-safe)
  return guardCheck(snap);
}

/** today's realized P&L per the guard's day reference (0 before the
 *  first gate check of the day). Used by the feed's tiered sizing. */
export async function crossGuardDayPnl(): Promise<number> {
  if (!enabled()) return 0;
  const snap = await fetchSnapshot();
  if (!snap) return 0; // sizing fails open — the gate still protects the order
  const s = guardState();
  if (s.dayKey !== tradingDayKey()) return 0;
  return snap.realized - s.dayStartRealized;
}
