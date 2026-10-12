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

export function registerTimeExit(e: { key: string; label: string; symbol: string; dir: "long" | "short"; exitAtMs: number }) {
  if (!enabled()) return;
  pending.set(e.key, { ...e, alerted: false });
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
    const decision = timeExitDecision(now, e.exitAtMs, held === undefined ? (held = await readHeldMnq()) : held);
    if (decision === "wait") continue;
    if (decision === "hold") {
      // past exitAt but the book is unreadable or already flat — keep the
      // entry waiting one more tick; drop it only once it is CONFIRMED flat
      if (held === 0) pending.delete(key);
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
        ? `⏱ <b>TIME EXIT</b> — <code>${e.label}</code> closed ${qty} MNQ at +${Math.round((now - e.exitAtMs) / 60000)} min past the ${e.label.includes("rth") ? "45" : "60"}-bar window · ${res.reason}`
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
