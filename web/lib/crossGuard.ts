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
import {
  guardCheck,
  guardState,
  guardStateFile,
  guardRestoredFromFile,
  hydrateGuardFromDb,
  tradingDayKey,
  type GuardDecision,
} from "./accountGuard";
import { accountRow, ctSnapshot, ctSnapshotDisplay, type CtSnapshot } from "./ctAccount";

type Snapshot = { equity: number; realized: number };

/** map the shared ctAccount snapshot to the guard's two numbers —
 *  equity = netLiq, realized = realizedPnl (unchanged contract) */
function mapSnapshot(s: CtSnapshot | null): Snapshot | null {
  if (!s || !s.accounts) return null;
  const acct = accountRow(s, process.env.CROSSTRADE_ACCOUNT ?? "");
  return acct && Number.isFinite(acct.netLiq) && Number.isFinite(acct.realizedPnl)
    ? { equity: Number(acct.netLiq), realized: Number(acct.realizedPnl) }
    : null;
}

/** DISPLAY-ONLY read of the last cached account snapshot (no fetch, no
 *  state mutation) — the dashboard's status bar mirrors what the gate
 *  saw. Never used by the gate or sizing. */
export function crossGuardSnapshot(): Snapshot | null {
  return mapSnapshot(ctSnapshotDisplay());
}

/** DISPLAY-ONLY: the snapshot for the status bar — the cached read when
 *  one exists, otherwise a fresh fetch (the gate path itself is
 *  unaffected; it always fetches through crossGuardGate). */
export async function crossGuardLiveSnapshot(): Promise<Snapshot | null> {
  const cached = mapSnapshot(ctSnapshotDisplay());
  if (cached) return cached;
  return fetchSnapshot();
}

function enabled(): boolean {
  return !!process.env.CROSSTRADE_URL && !!process.env.CROSSTRADE_KEY && !!process.env.CROSSTRADE_ACCOUNT;
}

/** the 30s-cached snapshot read (now via the shared ctAccount cache —
 *  the same window the display paths use, so gate and status bar can
 *  never disagree on the same read). */
async function fetchSnapshot(): Promise<Snapshot | null> {
  return mapSnapshot(await ctSnapshot());
}

let bootstrapped = false;
function bootstrap(snap: Snapshot) {
  if (bootstrapped) return;
  const stateFile = guardStateFile();
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
  // restore the persisted floor/day counter (redeploy-safe). Fail closed
  // when the day baseline cannot be restored MID-DAY: re-baselining at the
  // current realized would undercount the $900 consistency day. BOTH the
  // DB and the guard state file count as a restorable source. The first
  // 120 min of a trading day are exempt — a deploy around the 18:00 ET
  // reopen has no prior day P&L to lose (2026-10-07 08:37 redeploy: 14h
  // into the day, no DB, no file → halt, never silently re-baseline).
  const hydrated = await hydrateGuardFromDb();
  const s = guardState();
  const dayStartMs = Date.parse(`${tradingDayKey()}T22:00:00Z`); // day key 18:00 ET (EDT)
  const midDay = Date.now() - dayStartMs > 120 * 60_000;
  if (!hydrated && !guardRestoredFromFile() && s.dayKey === "" && midDay && snap.realized !== 0) {
    return {
      verdict: "halt-baseline",
      reason:
        "day baseline unrestorable (guard_state DB unreachable AND no state file) with realized ≠ 0 mid-day — refusing to re-baseline (consistency counter)",
    };
  }
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

/** the day-plan drawdown multiplier (dd600→half): 0.5 while the challenge
 *  drawdown from the trailing reference is >= DD_HALF_AT, back to 1 at
 *  DD_FULL_AT. The hysteresis flag lives in the guard state (updated on
 *  every gate check); this read is pure. DD_HALF_AT=0 disables. */
export async function crossGuardSizeMult(): Promise<number> {
  if (!enabled()) return 1;
  const ddHi = Number(process.env.DD_HALF_AT ?? "600");
  if (!Number.isFinite(ddHi) || ddHi <= 0) return 1;
  const s = guardState();
  return s.ddHalved ? Number(process.env.DD_HALF_MULT ?? "0.5") : 1;
}

/* ------------------------------------------------------------------ *
 * Day-P&L keep-alive poll (2026-10-07 fix): guardCheck used to run ONLY
 * on entry attempts, so dayPnl/dayPeak froze whenever nothing entered
 * (the RTH cap skips cards feed-side, before the gate — the 2026-10-07
 * afternoon showed dayPnl 0 with +$500.9 realized). This timer runs the
 * SAME guardCheck on the cached snapshot every minute: the day tracking
 * (rollover, dayPeak, profit arm, give-back reference) stays live
 * between entries. The entry gate itself is unchanged — the poll's
 * verdict is logged, never acted on.
 * ------------------------------------------------------------------ */

let pollStarted = false;

/** 25s cadence (2026-10-12): the snapshot cache TTL is 30s, so the old
 *  60s poll left the cache STALE at card time and every card paid a
 *  fresh REST hop before dispatch (applyDayTier reads the same cache).
 *  25s < 30s keeps the cache warm — the tick-time sizing read becomes a
 *  cache hit and the dispatch pre-flight is the only fresh read. */
export function startCrossGuardPoll(intervalMs = 25_000): void {
  if (pollStarted || !enabled()) return;
  pollStarted = true;
  setInterval(() => {
    void (async () => {
      try {
        const snap = await fetchSnapshot();
        if (!snap) return; // unreadable account — the gate still fails closed at entry
        bootstrap(snap);
        const d = guardCheck(snap);
        if (d.verdict !== "ok") console.log(`[guard] poll: ${d.verdict} — ${d.reason}`);
      } catch {
        /* the poll is best-effort — never crash the server on it */
      }
    })();
  }, intervalMs);
}

/** boot warm (2026-10-12): preload the account snapshot + guard
 *  hydration before the feed starts, so the session's FIRST card skips
 *  the cold REST/DB hops. Called from instrumentation, best-effort. */
export async function warmGuardState(): Promise<void> {
  if (!enabled()) return;
  try {
    await Promise.all([fetchSnapshot(), hydrateGuardFromDb({ force: true })]);
  } catch {
    /* warm is best-effort — the gate re-reads fresh at placement */
  }
}
