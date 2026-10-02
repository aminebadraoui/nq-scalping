/* ------------------------------------------------------------------ *
 * Execution watcher — "a card fired, but did it fill?"
 *
 * When the feed is LIVE (EXECUTE_LIVE=1), every trade card is registered
 * here at send time. 90 seconds later the watcher checks the CrossTrade
 * session fills for a matching entry; if none, it sends a Telegram
 * alert once per card. This turns silent execution failures (webhook
 * timeouts, flat refusals, rejected payloads, a crashed feed) into an
 * immediate, diagnosable event instead of a post-mortem.
 *
 * No new polling loop: the signal feed's 30s tick calls execWatch.check()
 * (the same pattern as the runner tracker). Fill reads are cached 60s.
 * ------------------------------------------------------------------ */

import { sendTelegram } from "./notify";

export type Expectation = {
  key: string;
  ts: number; // epoch ms at card time
  side: "long" | "short";
  contracts: number;
  label: string;
};

const CHECK_AFTER_MS = 90_000;
const GIVE_UP_MS = 10 * 60_000;
const FILL_CACHE_MS = 60_000;
const MATCH_WINDOW_MS = 5 * 60_000;

let pending = new Map<string, Expectation>();
let alerted = new Set<string>();
let fillCache: { at: number; fills: Array<{ ts: number; action: string; qty: number }> } | null = null;

function enabled(): boolean {
  return (
    process.env.EXECUTE_LIVE === "1" &&
    !!process.env.CROSSTRADE_KEY &&
    !!process.env.CROSSTRADE_ACCOUNT &&
    !!process.env.TELEGRAM_BOT_TOKEN &&
    !!process.env.TELEGRAM_CHAT_ID
  );
}

async function fetchFills(): Promise<Array<{ ts: number; action: string; qty: number }>> {
  if (fillCache && Date.now() - fillCache.at < FILL_CACHE_MS) return fillCache.fills;
  try {
    const res = await fetch("https://app.crosstrade.io/v1/api/tv/fills", {
      headers: {
        Authorization: `Bearer ${process.env.CROSSTRADE_KEY ?? ""}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
    const fills: Array<{ ts: number; action: string; qty: number }> = [];
    for (const env of j.data ?? []) {
      for (const f of env.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts)) continue;
        fills.push({ ts, action: String(f.action), qty: Number(f.qty ?? 0) });
      }
    }
    fillCache = { at: Date.now(), fills };
    return fills;
  } catch {
    return fillCache?.fills ?? [];
  }
}

/** register a just-sent trade card (no-op when not live) */
export function registerExpectation(e: Expectation) {
  if (!enabled()) return;
  pending.set(e.key, e);
}

/** a place-attempt returned not-ok (UNKNOWN network, guard halt, REST
 *  rejection, not-flat): alert immediately with the reason — no need to
 *  wait for the 90s fill check. No-op when not live. */
export function registerSendFailure(key: string, label: string, reason: string) {
  if (!enabled()) return;
  if (alerted.has(key)) return;
  alerted.add(key);
  pending.delete(key);
  const text = [
    `🚨 <b>EXECUTION FAILED — no order sent</b>`,
    `<code>${label}</code>`,
    `${reason}`,
    `<i>no automatic retry (exactly-once policy) — verify account state before acting</i>`,
  ].join("\n");
  void sendTelegram(text, { parseMode: "HTML" }).catch(() => {});
}

/** called from the feed tick: alert on unfilled cards */
export async function checkExpectations(): Promise<void> {
  if (!enabled() || pending.size === 0) return;
  const now = Date.now();
  let fills: Array<{ ts: number; action: string; qty: number }> | null = null;
  for (const [key, e] of pending) {
    if (now - e.ts < CHECK_AFTER_MS) continue;
    if (now - e.ts > GIVE_UP_MS) {
      pending.delete(key);
      continue;
    }
    if (alerted.has(key)) {
      pending.delete(key); // alerted once — stop watching this card
      continue;
    }
    fills = fills ?? (await fetchFills());
    const want = e.side === "long" ? "Buy" : "Sell";
    const matched = fills.some(
      (f) =>
        f.action === want &&
        f.qty >= Math.max(1, Math.floor(e.contracts * 0.8)) &&
        f.ts >= e.ts - 10_000 &&
        f.ts <= e.ts + MATCH_WINDOW_MS,
    );
    if (!matched) {
      alerted.add(key);
      pending.delete(key);
      const text = [
        `🚨 <b>EXECUTION CHECK — no fill found</b>`,
        `<code>${e.label} · ${e.side.toUpperCase()} ${e.contracts} MNQ · card ${new Date(e.ts).toISOString().slice(11, 19)}Z</code>`,
        `the card fired but CrossTrade shows no matching fill within 90s — check the webhook, Alert History and account state`,
      ].join("\n");
      void sendTelegram(text, { parseMode: "HTML" }).catch(() => {});
    } else {
      pending.delete(key);
    }
  }
}

/** TEST ONLY: reset the watcher state. */
export function __resetExecWatchForTest() {
  pending = new Map();
  alerted = new Set();
  fillCache = null;
}
