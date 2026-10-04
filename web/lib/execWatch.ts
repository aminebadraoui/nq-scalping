/* ------------------------------------------------------------------ *
 * Execution watcher — "a card fired, but did it fill?" — with a
 * bounded, broker-VERIFIED re-send loop.
 *
 * When the feed is LIVE (EXECUTE_LIVE=1) every trade card is registered
 * at send time. 90 seconds later the watcher checks the CrossTrade
 * session fills for a matching entry. If none:
 *
 *   AUTO_RETRY_VERIFIED=1 (default ON): the watcher VERIFIES with the
 *     broker — no MNQ working order AND no MNQ position — before
 *     re-sending the ORIGINAL intent. Every attempt is broker-verified,
 *     never blind: a failed re-send keeps the card registered and is
 *     retried up to MAX_RESEND_ATTEMPTS times, 90s apart, each attempt
 *     re-verifying the book and re-checking staleness (price moved more
 *     than half the risk → the entry is dead and retries stop). News
 *     blackout windows defer a retry rather than firing into them.
 *     Structural failures (bad symbol/stop/target, an open position)
 *     abort the loop immediately — no retry can fix them.
 *   AUTO_RETRY_VERIFIED=0: alert only, never re-send (the old behavior).
 *
 * Send failures alert immediately with the reason; with verified retry
 * armed the same card stays registered so the 90s check re-sends it
 * after the broker verification. Fill reads are cached 60s. No new
 * polling loop: the signal feed's 30s tick calls checkExpectations()
 * (the runner-tracker pattern).
 * ------------------------------------------------------------------ */

import { sendTelegram } from "./notify";
import { placeOrder, placeScaleOut, type OrderIntent } from "./executor";
import { momentumProfile, timeExitAt } from "./profile";
import { registerTimeExit } from "./timeExit";
import { getLive } from "./live";
import { logExec } from "./execLog";
import { signalWindowOpen } from "./marketHours";
import { newsBlockedNow } from "./newsGate";

export type Expectation = {
  key: string;
  ts: number; // epoch ms at card time
  label: string;
  intent: OrderIntent;
  scaleOut: boolean;
  /** true when the ORIGINAL place attempt returned not-ok. The verified
   *  re-send applies ONLY here: a card whose send succeeded but shows no
   *  fill is a data-lag problem, not a missing order — re-sending it
   *  risks a double (the 14:21 stack that cost ~$180). */
  sendFailed: boolean;
  /** verified re-send attempts made so far (bounded by MAX_RESEND_ATTEMPTS) */
  attempts: number;
  /** epoch ms of the last re-send attempt (throttled by RETRY_INTERVAL_MS) */
  lastAttemptAt: number;
};

const CHECK_AFTER_MS = 90_000;
const GIVE_UP_MS = 10 * 60_000;
const RETRY_INTERVAL_MS = 90_000;
const MAX_RESEND_ATTEMPTS = 3;
const FILL_CACHE_MS = 60_000;
const MATCH_WINDOW_MS = 5 * 60_000;
const MNQ = "MNQ";

let pending = new Map<string, Expectation>();
let alerted = new Set<string>();
let failedKeys = new Set<string>();
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

function autoRetry(): boolean {
  return process.env.AUTO_RETRY_VERIFIED !== "0";
}

async function alert(text: string) {
  await sendTelegram(text, { parseMode: "HTML" }).catch(() => {});
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

/** fill match: the trade side printed >= 80% of the contracts within the window */
export function fillMatches(
  e: { ts: number; intent: { dir: "long" | "short"; contracts: number } },
  fills: Array<{ ts: number; action: string; qty: number }>,
  now: number,
): boolean {
  const want = e.intent.dir === "long" ? "Buy" : "Sell";
  const need = Math.max(1, Math.floor(e.intent.contracts * 0.8));
  return fills.some(
    (f) =>
      f.action === want &&
      f.qty >= need &&
      f.ts >= e.ts - 10_000 &&
      f.ts <= e.ts + MATCH_WINDOW_MS,
  );
}

/** broker verification: is the MNQ book clean (no working order, no position)?
 *  clean=true is ONLY returned when both reads succeed AND show nothing —
 *  any read failure returns clean=false with the reason. */
export async function verifyAbsent(): Promise<{ clean: boolean; reason: string }> {
  const key = process.env.CROSSTRADE_KEY ?? "";
  const account = process.env.CROSSTRADE_ACCOUNT ?? "";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    // working orders on the account (a placed-but-unfilled order lives here)
    const ordRes = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/orders`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    const ordJ = (await ordRes.json()) as { success?: boolean; error?: string; data?: Array<Record<string, unknown>> };
    if (!ordJ.success) return { clean: false, reason: `orders read failed: ${String(ordJ.error ?? "")}` };
    const working = (ordJ.data ?? []).filter((o) =>
      String(o.instrument ?? o.contractName ?? "").includes(MNQ),
    );
    if (working.length > 0) return { clean: false, reason: `${working.length} working MNQ order(s) — likely placed` };

    // positions (fill-reconciled): the ultimate truth — a filled order shows here
    const posRes = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/positions`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    const posJ = (await posRes.json()) as { success?: boolean; error?: string; data?: Array<Record<string, unknown>> };
    if (!posJ.success) return { clean: false, reason: `positions read failed: ${String(posJ.error ?? "")}` };
    const held = (posJ.data ?? []).filter((p) => {
      const qty = Number(p.netPos ?? p.qty ?? 0);
      const ins = String(p.instrument ?? p.contractName ?? "");
      return qty !== 0 && ins.includes(MNQ);
    });
    if (held.length > 0) return { clean: false, reason: "MNQ position open — the order likely filled" };

    return { clean: true, reason: "no working order, no position — verified absent" };
  } catch (e) {
    return { clean: false, reason: `verification failed (${String(e)})` };
  }
}

/** live price vs the signal entry — skip the re-send if the market has
 *  moved more than half the risk (a stale entry is a different trade). */
export function priceDistancePts(e: { intent: OrderIntent }): number | null {
  const live = getLive().state;
  const ltp = live.snapshot?.ltp ?? live.minutes.at(-1)?.c ?? null;
  if (ltp === null || !Number.isFinite(ltp)) return null;
  return Math.abs(ltp - e.intent.entry);
}

/** register a just-sent trade card (no-op when not live) */
export function registerExpectation(e: Omit<Expectation, "sendFailed" | "attempts" | "lastAttemptAt">) {
  if (!enabled()) return;
  pending.set(e.key, { ...e, sendFailed: failedKeys.has(e.key), attempts: 0, lastAttemptAt: 0 });
}

/** pure decision helper (unit-tested): what to do when the 90s check
 *  finds no fill for a card. Only a FAILED send may be re-sent, and
 *  only when the broker verifies absent. */
export function resendDecision(
  sendFailed: boolean,
  verifiedAbsent: boolean,
): "resend" | "alert_only" | "silent" {
  if (sendFailed) return verifiedAbsent ? "resend" : "silent";
  return verifiedAbsent ? "alert_only" : "silent";
}

/** structural failures no retry can fix (bad symbol/stop/target, an open
 *  position the flat gate refuses) — these abort the retry loop at once.
 *  Transient guard/latch/network failures keep retrying (each attempt is
 *  still broker-verified and stale-checked). */
export function isRetryableFailure(reason: string): boolean {
  if (reason.includes("cannot map symbol")) return false;
  if (reason.includes("invalid stop")) return false;
  if (reason.includes("invalid target")) return false;
  if (reason.includes("not flat — an MNQ position is open")) return false;
  return true;
}

/** a place-attempt returned not-ok: alert immediately. With verified
 *  retry armed, the card stays registered so the 90s check re-sends it
 *  after the broker verification. */
export function registerSendFailure(key: string, label: string, reason: string) {
  if (!enabled()) return;
  if (alerted.has(key)) return;
  failedKeys.add(key);
  if (pending.has(key)) pending.get(key)!.sendFailed = true;
  const willRetry = autoRetry() && pending.has(key);
  alerted.add(key);
  if (!willRetry) pending.delete(key);
  const text = [
    `🚨 <b>EXECUTION FAILED — no order sent</b>`,
    `<code>${label}</code>`,
    `${reason}`,
    willRetry
      ? `<i>will verify with the broker and re-send (up to ${MAX_RESEND_ATTEMPTS} verified attempts, ${RETRY_INTERVAL_MS / 1000}s apart) while the book stays clean</i>`
      : `<i>no automatic retry (exactly-once policy) — verify account state before acting</i>`,
  ].join("\n");
  void alert(text);
}

/** called from the feed tick: the 90s verification + optional re-send */
export async function checkExpectations(): Promise<void> {
  if (!enabled() || pending.size === 0) return;
  const now = Date.now();
  let fills: Array<{ ts: number; action: string; qty: number }> | null = null;
  for (const [key, e] of [...pending]) {
    // signal window (owner rule): nothing is ever placed outside
    // Sunday 18:00 ET → Friday 16:00 ET (daily 16:00–18:00 halt Mon–Thu) —
    // entries stay pending and are dropped by the give-up clock once it
    // expires (no weekend re-send).
    if (!signalWindowOpen(now)) continue;
    if (now - e.ts < CHECK_AFTER_MS) continue;
    if (now - e.ts > GIVE_UP_MS) {
      pending.delete(key);
      if (!alerted.has(key) || e.sendFailed) {
        alerted.add(key);
        void alert(`⚠ <b>EXECUTION UNCONFIRMED</b> — <code>${e.label}</code> never confirmed after 10 min`);
      }
      continue;
    }
    fills = fills ?? (await fetchFills());
    if (fillMatches(e, fills, now)) {
      pending.delete(key);
      continue;
    }

    if (!autoRetry()) {
      if (!alerted.has(key)) {
        alerted.add(key);
        pending.delete(key);
        void alert(`🚨 <b>EXECUTION CHECK — no fill found</b> — <code>${e.label}</code>`);
      }
      continue;
    }

    // verified re-send path (bounded retries per card). A card whose send
    // FAILED was alerted at send time (alerted contains its key) but must
    // still run the broker verification + re-sends — that is the whole
    // point of the verified retry. Cards that were never send-failed are
    // dropped here once alerted.
    if (alerted.has(key) && !e.sendFailed) {
      pending.delete(key);
      continue;
    }
    // throttle: one verified attempt per RETRY_INTERVAL_MS (the first
    // watch is already gated by CHECK_AFTER_MS above)
    if (e.sendFailed && e.attempts > 0 && now - e.lastAttemptAt < RETRY_INTERVAL_MS) continue;
    alerted.add(key);
    const v = await verifyAbsent();
    void logExec({ key, label: e.label, attempt: "watch", outcome: v.clean ? "verified_absent" : "unresolved", reason: v.reason });
    const decision = resendDecision(e.sendFailed, v.clean);
    if (decision === "silent") {
      // the order exists (working order / position) or the send failed
      // but the book is not clean — nothing to do
      pending.delete(key);
      if (!v.clean) {
        void alert(`⚠ <b>EXECUTION UNRESOLVED</b> — <code>${e.label}</code>\n${v.reason} — verify manually before acting`);
      }
      continue;
    }
    if (decision === "alert_only") {
      // send succeeded but no fill is visible: a data-lag, NOT a missing
      // order — re-sending could double the position. Alert, never re-send.
      pending.delete(key);
      void alert(
        `⚠ <b>SEND OK BUT NO FILL VISIBLE</b> — <code>${e.label}</code>\nthe order was placed but no fill is showing and the book reads clean — verify manually, do NOT re-send`,
      );
      continue;
    }
    // decision === "resend": original send FAILED and the book verifies clean
    const nb = newsBlockedNow(now);
    if (nb) {
      // defer, don't drop: a retry that would fire inside a blackout window
      // waits for it to pass (still bounded by the give-up clock)
      void logExec({ key, label: e.label, attempt: "watch", outcome: "deferred_blackout", reason: nb });
      e.lastAttemptAt = now;
      continue;
    }
    const dist = priceDistancePts(e);
    const risk = Math.abs(e.intent.entry - e.intent.stop);
    if (dist !== null && dist > 0.5 * risk) {
      pending.delete(key);
      void logExec({ key, label: e.label, attempt: "watch", outcome: "skipped_stale", reason: `price moved ${dist.toFixed(1)} pts (risk ${risk.toFixed(1)})` });
      void alert(
        `⚠ <b>RE-SEND SKIPPED — stale entry</b> — <code>${e.label}</code>\nprice moved ${dist.toFixed(1)} pts from the signal (risk ${risk.toFixed(1)}) — not re-entering`,
      );
      continue;
    }
    const res = e.scaleOut ? await placeScaleOut(e.intent) : await placeOrder(e.intent);
    e.attempts += 1;
    e.lastAttemptAt = now;
    if (res.ok) {
      if (!e.scaleOut) {
        const prof = momentumProfile();
        if (prof.enabled) {
          registerTimeExit({
            key,
            label: e.label,
            symbol: e.intent.symbol,
            dir: e.intent.dir,
            exitAtMs: timeExitAt(Date.now(), prof),
          });
        }
      }
      pending.delete(key);
      void logExec({
        key,
        label: e.label,
        attempt: "resend",
        outcome: "resend_ok",
        reason: res.reason,
      });
      void alert(`🔁 <b>AUTO RE-SENT</b> — <code>${e.label}</code> verified absent, re-sent (attempt ${e.attempts}/${MAX_RESEND_ATTEMPTS}): ${res.reason}`);
      continue;
    }
    // failed re-send: retry while the failure can plausibly clear, the
    // attempt budget lasts, and the give-up clock hasn't expired
    const retryable = isRetryableFailure(res.reason);
    if (retryable && e.attempts < MAX_RESEND_ATTEMPTS && now - e.ts < GIVE_UP_MS) {
      void logExec({
        key,
        label: e.label,
        attempt: "resend",
        outcome: "resend_failed_retrying",
        reason: res.reason,
      });
      void alert(
        `🔁 <b>RE-SEND FAILED (attempt ${e.attempts}/${MAX_RESEND_ATTEMPTS})</b> — <code>${e.label}</code>\n${res.reason}\n<i>broker-verified retry in ~${RETRY_INTERVAL_MS / 1000}s</i>`,
      );
      continue; // stays pending — next verified attempt after the throttle
    }
    pending.delete(key);
    void logExec({
      key,
      label: e.label,
      attempt: "resend",
      outcome: retryable ? "resend_gave_up" : "resend_aborted",
      reason: res.reason,
    });
    void alert(
      retryable
        ? `🚨 <b>RE-SEND GAVE UP</b> — <code>${e.label}</code> — ${MAX_RESEND_ATTEMPTS} verified attempts failed: ${res.reason}`
        : `🚨 <b>RE-SEND ABORTED</b> — <code>${e.label}</code> — ${res.reason} (not retryable)`,
    );
  }
}

/** TEST ONLY: reset the watcher state. */
export function __resetExecWatchForTest() {
  pending = new Map();
  alerted = new Set();
  failedKeys = new Set();
  fillCache = null;
}
