/* ------------------------------------------------------------------ *
 * Time-exit tracker — the profile's bar-based time exit. When a
 * profile order fires, register {exitAt = entry time + bars}; on the
 * feed's 30s tick, checkTimeExits() reads the MNQ book and, once
 * exitAt has passed with a position still open, sends a bracketless
 * REST market exit (the entry's OCO brackets cancel on the flatten).
 *
 * Safety mirrors the rest of the executor: dry-run unless
 * EXECUTE_LIVE=1, unreadable book ⇒ keep waiting (never guess), a
 * fired exit is removed from the tracker regardless of outcome (no
 * auto-retry — UNKNOWN results alert for manual reconciliation).
 * In-memory only: a redeploy drops pending exits (the position then
 * runs its exchange-side bracket to completion — loss of a time exit,
 * not of protection).
 * ------------------------------------------------------------------ */

import { sendTelegram } from "./notify";
import { placeCrossTradeExitREST } from "./crossTrade";
import { timeExitDecision } from "./profile";
import { ctPositions } from "./ctAccount";

type TimeExit = {
  key: string;
  label: string;
  symbol: string;
  dir: "long" | "short";
  exitAtMs: number;
  alerted: boolean;
  /** the trade's position has been observed open (on its side) */
  seenOpen: boolean;
  /** registered at a CONFIRMED fill (market entry / matched limit fill):
   *  only then may "seen open → flat" end the exit early. An exit
   *  registered before its entry fills (a resting RTH limit, the VWAP-UP
   *  15:59 flat) cannot tell its own position from another family's,
   *  so it keeps the deadline-only behavior (2026-10-26 review). */
  filled: boolean;
};

let pending = new Map<string, TimeExit>();
let alerted = new Set<string>();

function enabled(): boolean {
  return (
    process.env.EXECUTE_LIVE === "1" &&
    !!process.env.CROSSTRADE_KEY &&
    !!process.env.CROSSTRADE_ACCOUNT &&
    !!process.env.TELEGRAM_BOT_TOKEN &&
    !!process.env.TELEGRAM_CHAT_ID
  );
}

export function registerTimeExit(e: { key: string; label: string; symbol: string; dir: "long" | "short"; exitAtMs: number; filled?: boolean }) {
  if (!enabled()) return;
  pending.set(e.key, { ...e, alerted: false, seenOpen: false, filled: e.filled === true });
}

async function readHeldMnq(): Promise<number | null> {
  // the shared read layer: WS-mirror → 2s cache → REST, penalty-gated —
  // the 30s exit tick must not spend the vendor budget on its own fetch
  const rows = await ctPositions();
  if (rows === null) return null;
  let held = 0;
  for (const p of rows) {
    const r = p as Record<string, unknown>;
    const qty = Number(r.netPos ?? r.qty ?? 0);
    const ins = String(r.instrument ?? r.contractName ?? "");
    if (qty !== 0 && ins.includes("MNQ")) held += qty;
  }
  return held;
}

/** called from the feed's 30s tick */
export async function checkTimeExits(): Promise<void> {
  if (!enabled() || pending.size === 0) return;
  const now = Date.now();
  let held: number | null | undefined;
  for (const [key, e] of [...pending]) {
    if (held === undefined) held = await readHeldMnq();
    // lifecycle: once this trade's position has been SEEN open and the
    // book later reads flat, the trade is over — drop its exit now
    // instead of letting it fire at the deadline against whatever
    // position exists then (a later trade). An entry not yet filled (a
    // resting limit) reads flat without having been seen open: kept.
    if (e.filled && held !== null && held !== 0 && (e.dir === "long" ? held > 0 : held < 0)) e.seenOpen = true;
    if (e.filled && held === 0 && e.seenOpen) {
      pending.delete(key);
      continue;
    }
    const decision = timeExitDecision(now, e.exitAtMs, held, e.dir);
    if (decision === "wait") continue;
    if (decision === "hold") {
      // past exitAt but the book is unreadable, flat, or on the other
      // side — keep waiting while unreadable; drop once flat or opposite
      if (held !== null) pending.delete(key);
      continue;
    }
    pending.delete(key);
    if (alerted.has(key)) continue;
    alerted.add(key);
    const qty = Math.abs(held ?? 0);
    if (qty < 1) continue;
    const res = await placeCrossTradeExitREST({ symbol: e.symbol, dir: e.dir, contracts: qty });
    const ok = res.ok;
    void sendTelegram(
      ok
        ? `⏱ <b>TIME EXIT</b> — <code>${e.label}</code> closed ${qty} MNQ at +${Math.round((now - e.exitAtMs) / 60000)} min past the ${e.label.includes("session-continuation") || e.label.includes("rth") ? "45" : "60"}-bar window · ${res.reason}`
        : `🚨 <b>TIME EXIT FAILED</b> — <code>${e.label}</code> · ${res.reason} — position still open, close manually`,
      { parseMode: "HTML" },
    ).catch(() => {});
  }
}

/** TEST ONLY: reset the tracker state. */
export function __resetTimeExitForTest() {
  pending = new Map();
  alerted = new Set();
}
