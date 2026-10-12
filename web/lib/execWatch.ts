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
 * after the broker verification. Fill reads are cached 5s. The check
 * runs on its OWN 5s timer (startWatchTimers, booted from
 * instrumentation) — never on the feed tick, so the dispatch-critical
 * loop carries no watcher work — and pushed broker FILL events from the
 * CrossTrade WebSocket stream (lib/ctStream.ts) trigger an IMMEDIATE
 * confirm pass (onPushedEntryFill → checkExpectations({immediate}))
 * that only MATCHES fills: it closes the submit→fill leg, registers
 * time exits at the true fill time and runs the protection sweep, but
 * it can never re-send or drop a pending card (the no-fill branches
 * stay behind the 90s gate).
 * ------------------------------------------------------------------ */

import { sendTelegram } from "./notify";
import { placeOrder, placeScaleOut, cancelOrder, type OrderIntent } from "./executor";
import { stopCrossedAtDispatch, limitCrossedAtDispatch, currentTapeLtp, repairNakedPosition, openProtection, setOpenProtection, reanchorBracketForFill, rearmCrossTradeBracketREST } from "./crossTrade";
import { tradingHalted } from "./tradingHalt";
import { momentumProfile, timeExitAt } from "./profile";
import { registerTimeExit } from "./timeExit";
import { getLive } from "./live";
import { logExec } from "./execLog";
import { noteOrderFill } from "./execLatency";
import { signalWindowOpen } from "./marketHours";
import { newsBlockedNow } from "./newsGate";
import { noteRthExit } from "./rthExitLog";

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
  /** resting-LIMIT entry: the watcher waits for the fill instead of the
   *  resend flow, and CANCELS the order when the window closes, the
   *  expiry passes, or the give-up clock fires — a limit must never
   *  outlive the card that placed it. */
  limit?: { orderId?: string; price: number; expireAtMs: number };
};

const CHECK_AFTER_MS = 90_000;
const GIVE_UP_MS = 10 * 60_000;
const RETRY_INTERVAL_MS = 90_000;
const MAX_RESEND_ATTEMPTS = 3;
/** 5s (was 60s): the pushed-fill immediate pass needs a fresh-ish fill
 *  list to match against; 5s keeps the REST load low while making the
 *  5s timer's confirm passes accurate. */
const FILL_CACHE_MS = 5_000;
const MATCH_WINDOW_MS = 5 * 60_000;
const MNQ = "MNQ";

let pending = new Map<string, Expectation>();
let alerted = new Set<string>();
let failedKeys = new Set<string>();
let fillCache: { at: number; fills: Array<{ ts: number; action: string; qty: number; price: number }> } | null = null;

/* ---- protection watchdog (2026-10-08 naked-position incident) --------- *
 * The executor (lib/crossTrade.ts) owns the GLOBAL safety invariants:
 * every REST placement — market or limit, any caller — registers its
 * bracket and verifies its OSO legs after placement. This module runs
 * the 30s account-level sweep: while an MNQ position is open, a working
 * stop must cover it, or the position is repaired (re-arm via
 * cancel_and_bracket, else flatten — repairNakedPosition). Untracked
 * positions (manual trades) are alert-only — never touched. */

const gpWatch = globalThis as unknown as {
  __gcNakedAlerted?: boolean;
  __gcNakedSince?: number | null;
};
function nakedAlerted(): boolean {
  return gpWatch.__gcNakedAlerted === true;
}
function setNakedAlerted(v: boolean): void {
  gpWatch.__gcNakedAlerted = v;
}
function nakedSince(): number | null {
  return gpWatch.__gcNakedSince ?? null;
}
function setNakedSince(t: number | null): void {
  gpWatch.__gcNakedSince = t;
}

/** a tracked naked position must persist across two consecutive 30s polls
 *  before the watchdog repairs it — Tradovate activates a suspended OSO
 *  stop a beat after the fill, and a re-arm in that window would replace
 *  the bracket with a 1-pt emergency stop. Evidence-based repairs (the
 *  executor's rejected-leg check) act immediately instead. Failed repairs
 *  are retried on a 2-minute cooldown while the position stays naked. */
const NAKED_PERSIST_MS = 10_000; // one poll at the 10s interval — the suspended-stop activation window is sub-second
const REPAIR_COOLDOWN_MS = 2 * 60_000;

/** pure classifier: does the working-order list contain a working stop
 *  that covers the position side? (long → a Sell stop; short → a Buy
 *  stop — Tradovate's own order rows carry action/ordStatus/stopPrice.) */
export function stopCoversPosition(orders: Array<Record<string, unknown>>, dir: "long" | "short"): boolean {
  const want = dir === "long" ? "Sell" : "Buy";
  return orders.some((o) => {
    const action = String(o.action ?? "").toLowerCase();
    const status = String(o.ordStatus ?? o.status ?? "").toLowerCase();
    const ins = String(o.instrument ?? o.contractName ?? "");
    const hasStop = o.stopPrice !== undefined && o.stopPrice !== null;
    const isStopType = String(o.orderType ?? o.type ?? "").toLowerCase().includes("stop");
    return ins.includes(MNQ) && (status === "working" || status === "") && action === want.toLowerCase() && (hasStop || isStopType);
  });
}

const REARM_VERIFY_DELAY_MS = 4000;

async function readWorkingOrders(): Promise<{ ok: boolean; orders: Array<Record<string, unknown>> }> {
  const key = process.env.CROSSTRADE_KEY ?? "";
  const account = process.env.CROSSTRADE_ACCOUNT ?? "";
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/orders`, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (!j.success) return { ok: false, orders: [] };
    return { ok: true, orders: j.data ?? [] };
  } catch {
    return { ok: false, orders: [] };
  }
}

/** the working-order check: is a stop actually covering this side? */
export async function findWorkingStop(dir: "long" | "short"): Promise<{ ok: boolean; found: boolean }> {
  const r = await readWorkingOrders();
  if (!r.ok) return { ok: false, found: false };
  return { ok: true, found: stopCoversPosition(r.orders, dir) };
}

/** shared short-TTL positions read for the OBSERVATIONAL paths (the
 *  protection sweep and the RTH winner-exit poll). Deliberately NOT used
 *  by the entry choke point (crossTrade.restFlatGate stays a fresh read —
 *  a stale flat answer could stack a position) nor by the re-send
 *  verification (verifyAbsent stays fresh — a stale clean book could
 *  double a position). Load-sharing only where staleness is harmless. */
let positionsCache: { at: number; rows: Array<Record<string, unknown>> | null } | null = null;
const POSITIONS_TTL_MS = 2_000;

async function fetchPositionsCached(): Promise<Array<Record<string, unknown>> | null> {
  if (positionsCache && Date.now() - positionsCache.at < POSITIONS_TTL_MS) return positionsCache.rows;
  const key = process.env.CROSSTRADE_KEY ?? "";
  const account = process.env.CROSSTRADE_ACCOUNT ?? "";
  let rows: Array<Record<string, unknown>> | null = null;
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/positions`, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
    rows = j.success ? j.data ?? [] : null;
  } catch {
    rows = null;
  }
  positionsCache = { at: Date.now(), rows };
  return rows;
}

/** signed MNQ position from the fill-reconciled read (null = flat or
 *  unreadable — callers treat unreadable as "keep waiting"). */
async function readMnqPosition(): Promise<{ qty: number; dir: "long" | "short" } | null> {
  const rows = await fetchPositionsCached();
  if (rows === null) return null;
  let qty = 0;
  for (const p of rows) {
    if (!String(p.instrument ?? p.contractName ?? "").includes(MNQ)) continue;
    qty += Number(p.netPos ?? p.qty ?? 0);
  }
  if (qty === 0) return null;
  return { qty, dir: qty > 0 ? "long" : "short" };
}

/** stop-slippage alarm (2026-10-08 −$1,056 event): when a tracked trade
 *  goes flat, compare the exit fill against the intended stop. A fill
 *  far beyond the stop means the stop-market chased a gap — the risk
 *  model priced the stop at its trigger, and reality disagreed. Alert +
 *  journal so execution quality is visible, not just P&L. */
async function checkExitSlippage(intent: OrderIntent): Promise<void> {
  const fills = await fetchFills();
  const want = intent.dir === "long" ? "Sell" : "Buy";
  const exits = fills.filter((f) => f.action === want);
  if (!exits.length) return;
  exits.sort((a, b) => a.ts - b.ts);
  const exit = exits[exits.length - 1];
  const verdict = classifyExitFill(intent, exit.price);
  if (verdict !== "stop_slipped") return;
  const gap = intent.dir === "long" ? intent.stop - exit.price : exit.price - intent.stop;
  void logExec({
    key: `protect|${Date.now()}`,
    label: `protection watchdog ${intent.dir}`,
    attempt: "watch",
    outcome: "stop_slipped",
    reason: `stop ${intent.stop.toFixed(2)} filled at ${exit.price.toFixed(2)} — ${gap.toFixed(1)} pts beyond the trigger`,
  });
  void alert(
    `🚨 <b>STOP SLIPPED ${gap.toFixed(1)} PTS</b> — <code>protection watchdog</code>\n` +
      `the stop at ${intent.stop.toFixed(2)} filled at ${exit.price.toFixed(2)} — ${gap.toFixed(1)} pts of gap-through slippage on ${intent.contracts} MNQ (≈ $${(gap * intent.contracts * 2).toFixed(0)}).\n` +
      `<i>execution-quality alarm — the planned risk was ${Math.abs(intent.entry - intent.stop).toFixed(1)} pts</i>`,
  );
}

/** the 30s protection watchdog: while an MNQ position is open, verify a
 *  working stop covers it. Tracked positions are repaired (re-arm →
 *  flatten); untracked ones (manual trades) alert only, never touched. */
export async function checkProtection(): Promise<void> {
  if (!enabled()) return;
  const pos = await readMnqPosition();
  const reg = openProtection();
  if (!pos) {
    if (reg) {
      // flat transition — the trade just exited. If the exit fill landed
      // far beyond the intended stop (gap-through slippage, the
      // 2026-10-08 −$1,056 event), scream: the risk model needs to know
      // its stop fills are not landing where they were priced.
      void checkExitSlippage(reg.intent);
      setOpenProtection(null); // flat — the entry closed or expired
    }
    return;
  }
  if (!reg || reg.intent.dir !== pos.dir) {
    if (reg) setOpenProtection(null);
    if (!nakedAlerted()) {
      setNakedAlerted(true);
      void logExec({
        key: `protect|${Date.now()}`,
        label: "protection watchdog",
        attempt: "watch",
        outcome: "naked_untracked",
        reason: `MNQ position ${pos.dir} open with no tracked bracket — verify manually`,
      });
      void alert(`⚠️ <b>UNTRACKED MNQ POSITION OPEN</b> — ${pos.dir} ${pos.qty} with no bracket we placed — verify manually (never auto-touched).`);
    }
    return;
  }
  const ws = await findWorkingStop(pos.dir);
  if (!ws.ok) return; // unreadable book — never guess, retry next poll
  if (ws.found) {
    setNakedAlerted(false);
    setNakedSince(null);
    return;
  }
  // tracked position with NO working stop: alert on the first poll and
  // repair only when the naked state persists across two polls — the
  // OSO stop activates a beat after the fill and a repair in that window
  // would replace the bracket with a 1-pt emergency stop
  const since = nakedSince();
  if (since === null) {
    setNakedSince(Date.now());
    void logExec({
      key: `protect|${Date.now()}`,
      label: `protection watchdog ${pos.dir}`,
      attempt: "watch",
      outcome: "stop_missing",
      reason: "position open with no working stop",
    });
    void alert(`🚨 <b>NO WORKING STOP ON OPEN POSITION</b> — ${pos.dir} ${pos.qty} MNQ — re-arming in ~30s if it persists (flatten fallback).`);
    return;
  }
  if (Date.now() - since < NAKED_PERSIST_MS) return;
  void repairNakedPosition(reg.intent, `protection watchdog ${pos.dir}`, `protect|${Date.now()}`);
  // retry on a cooldown while the position stays naked (repair alerts)
  setNakedSince(Date.now() + REPAIR_COOLDOWN_MS);
}

/* ---- RTH winner-exit tracking (feeds the counter-signal gate) -------- *
 * Bracket exits are exchange-side — the system never sees the exit fill
 * directly. This tracker learns exits from the broker: the open RTH
 * position is noted at fill confirmation, and a 30s poll detects the
 * flat transition; the opposite-side session fills since the entry are
 * the exit leg → win/loss → lib/rthExitLog. It can only ever SKIP a
 * later card via the feed's counter-gate — never place or change one. */

type OpenRthPos = { dir: "long" | "short"; entryPrice: number; at: number };

const gp = globalThis as unknown as { __gcOpenRthPos?: OpenRthPos | null };
function openRthPos(): OpenRthPos | null {
  return gp.__gcOpenRthPos ?? null;
}
function setOpenRthPos(p: OpenRthPos | null): void {
  gp.__gcOpenRthPos = p;
}

async function readMnqHeld(): Promise<number> {
  const rows = await fetchPositionsCached();
  if (rows === null) return -1;
  let held = 0;
  for (const p of rows) {
    if (String(p.instrument ?? p.contractName ?? "").includes(MNQ)) held += Number(p.qty ?? p.quantity ?? 0);
  }
  return held;
}

async function pollRthExit(): Promise<void> {
  const pos = openRthPos();
  if (!pos) return;
  const held = await readMnqHeld();
  if (held !== 0) return; // still open (or unreadable — retry next poll)
  // flat transition: the exit just happened — the opposite-side session
  // fills since the entry ARE the exit leg
  setOpenRthPos(null);
  const fills = await fetchFills();
  const want = pos.dir === "long" ? "Sell" : "Buy";
  const exits = fills.filter((f) => f.action === want && f.ts > pos.at);
  if (!exits.length) return;
  const qty = exits.reduce((s, f) => s + f.qty, 0);
  if (qty <= 0) return;
  const exitAvg = exits.reduce((s, f) => s + f.price * f.qty, 0) / qty;
  const pts = (exitAvg - pos.entryPrice) * (pos.dir === "long" ? 1 : -1);
  if (pts > 0) {
    noteRthExit(pos.dir, exitAvg, Date.now());
    console.log(`[rth-exit] ${pos.dir.toUpperCase()} winner logged — exit ${exitAvg.toFixed(2)} (+${pts.toFixed(1)} pts from signal ${pos.entryPrice.toFixed(2)})`);
  }
}

let exitPollStarted = false;

/** 30s broker poll that turns flat transitions into RTH winner-exit
 *  records for the counter-signal gate, and runs the protection
 *  watchdog (working-stop verification + naked-position repair).
 *  Started from instrumentation. */
export function startRthExitPoll(intervalMs = 10_000): void {
  if (exitPollStarted || !enabled()) return;
  exitPollStarted = true;
  setInterval(() => {
    void pollRthExit().catch(() => {});
    void checkProtection().catch(() => {});
  }, intervalMs);
}

function enabled(): boolean {
  return (
    process.env.EXECUTE_LIVE === "1" &&
    !!process.env.CROSSTRADE_KEY &&
    !!process.env.CROSSTRADE_ACCOUNT &&
    !!process.env.TELEGRAM_BOT_TOKEN &&
    !!process.env.TELEGRAM_CHAT_ID
  );
}

/** the 5s fill-expectation timer (2026-10-12): checkExpectations used to
 *  ride the feed tick, quantizing fill confirmation behind the 15s poll
 *  (effective 90–105s). Its own 5s cadence + the pushed-fill immediate
 *  pass cut fill→watcher latency from ~90s to <1s on the fill path. The
 *  CHECK_AFTER_MS gate is unchanged — only the check FREQUENCY moved. */
let watchTimerStarted = false;
export function startWatchTimers(intervalMs = 5_000): void {
  if (watchTimerStarted || !enabled()) return;
  watchTimerStarted = true;
  const timer = setInterval(() => {
    void checkExpectations().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

/** pushed entry FILL from the CrossTrade order stream (lib/ctStream.ts):
 *  a fill means the position exists NOW. Sweep protection immediately
 *  (the 10s watchdog otherwise waits) and run an immediate confirm pass
 *  so time exits register at the TRUE fill time and the submit→fill leg
 *  closes — the immediate pass only matches fills, never re-sends. */
export async function onPushedEntryFill(action: string, order: Record<string, unknown>): Promise<void> {
  if (!enabled()) return;
  const side = String(action ?? "").toLowerCase();
  if (side !== "buy" && side !== "sell") return; // stop/target legs are not entry fills
  void checkProtection().catch(() => {});
  void checkExpectations({ immediate: true }).catch(() => {});
}

function autoRetry(): boolean {
  return process.env.AUTO_RETRY_VERIFIED !== "0";
}

async function alert(text: string) {
  await sendTelegram(text, { parseMode: "HTML" }).catch(() => {});
}

async function fetchFills(force = false): Promise<Array<{ ts: number; action: string; qty: number; price: number }>> {
  if (!force && fillCache && Date.now() - fillCache.at < FILL_CACHE_MS) return fillCache.fills;
  try {
    const res = await fetch("https://app.crosstrade.io/v1/api/tv/fills", {
      headers: {
        Authorization: `Bearer ${process.env.CROSSTRADE_KEY ?? ""}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
    const fills: Array<{ ts: number; action: string; qty: number; price: number }> = [];
    for (const env of j.data ?? []) {
      for (const f of env.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts)) continue;
        fills.push({ ts, action: String(f.action), qty: Number(f.qty ?? 0), price: Number(f.price ?? 0) });
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
  fills: Array<{ ts: number; action: string; qty: number; price?: number }>,
  now: number,
): boolean {
  return findMatchingFill(e, fills, now) !== null;
}

/** the matched entry fill (with its price) — null when no fill matches.
 *  The fill PRICE is the execution-quality input for the re-anchor and
 *  slippage checks: it is where the trade actually got in, not the signal. */
export function findMatchingFill(
  e: { ts: number; intent: { dir: "long" | "short"; contracts: number } },
  fills: Array<{ ts: number; action: string; qty: number; price?: number }>,
  now: number,
): { ts: number; action: string; qty: number; price?: number } | null {
  const want = e.intent.dir === "long" ? "Buy" : "Sell";
  const need = Math.max(1, Math.floor(e.intent.contracts * 0.8));
  // the match contract is side/size/window only (unchanged); price rides
  // along when the caller's fill rows carry it (the watcher's always do)
  const matches = fills.filter(
    (f) => f.action === want && f.qty >= need && f.ts >= e.ts - 10_000 && f.ts <= e.ts + MATCH_WINDOW_MS,
  );
  if (!matches.length) return null;
  matches.sort((a, b) => a.ts - b.ts);
  return matches[matches.length - 1];
}

/** pure exit-fill classifier for the slippage alarm: was the flat
 *  transition a stop-out that filled beyond the intended stop? "target"
 *  = exited near the target (normal); "stop_slipped" = exited beyond the
 *  stop by more than thresholdPts; null = in between (manual/other). */
export function classifyExitFill(
  intent: { dir: "long" | "short"; stop: number; target: number },
  exitPrice: number,
  thresholdPts = 2,
): "target" | "stop_slipped" | null {
  if (!Number.isFinite(exitPrice)) return null;
  const stopGap = intent.dir === "long" ? intent.stop - exitPrice : exitPrice - intent.stop; // > 0 = beyond the stop
  const targetGap = Math.abs(exitPrice - intent.target);
  const stopDist = Math.abs(exitPrice - intent.stop);
  if (stopDist <= targetGap) {
    // the exit landed on the stop side of the bracket
    if (stopGap > thresholdPts) return "stop_slipped";
    return null; // stopped out near the trigger — the intended outcome
  }
  return "target";
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
  // the owner's kill switch: the card is info-only — nothing is placed,
  // so the watcher has nothing to verify, re-send, or alarm about
  if (tradingHalted()) return;
  pending.set(e.key, { ...e, sendFailed: failedKeys.has(e.key), attempts: 0, lastAttemptAt: 0 });
}

/** attach the broker-facing order id to a pending limit card after its
 *  placement returns (the id is ours by construction, so this is how the
 *  expiry cancel addresses the order). No-op when not live. */
export function attachLimitOrderId(key: string, orderId: string) {
  if (!enabled()) return;
  const e = pending.get(key);
  if (e?.limit) e.limit.orderId = orderId;
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
  // the executor's global gates: re-sending the same limit would just be
  // refused again (the tape is past the stop/limit — the entry is dead)
  if (reason.includes("crossed-stop gate")) return false;
  if (reason.includes("crossed-limit gate")) return false;
  if (reason.includes("trading halted")) return false;
  return true;
}

/** a place-attempt returned not-ok: alert immediately. With verified
 *  retry armed, the card stays registered so the 90s check re-sends it
 *  after the broker verification. */
export function registerSendFailure(key: string, label: string, reason: string) {
  if (!enabled()) return;
  if (reason.includes("trading halted")) return; // the owner's kill switch — intentional, not a failure to alarm about
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

/** single-flight guard: the 5s timer and the pushed-fill immediate pass
 *  must never run concurrently (two in-flight passes could both re-send
 *  the same card). A request that lands mid-flight sets a rerun flag. */
let checking = false;
let rerunRequested = false;

/** called from the 5s watcher timer and (immediate) from the pushed
 *  broker FILL event: the 90s verification + optional re-send. The
 *  IMMEDIATE pass only MATCHES fills — it closes the submit→fill leg,
 *  registers limit fills/time exits at the true fill time and sweeps
 *  protection; the no-fill branches (re-send, give-up, alert) stay
 *  behind the CHECK_AFTER_MS gate so a just-placed card can never be
 *  dropped or re-sent early. */
export async function checkExpectations(opts?: { immediate?: boolean }): Promise<void> {
  if (checking) {
    rerunRequested = true;
    return;
  }
  checking = true;
  try {
    await checkExpectationsOnce(opts);
  } finally {
    checking = false;
    if (rerunRequested) {
      rerunRequested = false;
      void checkExpectations().catch(() => {});
    }
  }
}

async function checkExpectationsOnce(opts?: { immediate?: boolean }): Promise<void> {
  const immediate = opts?.immediate === true;
  if (!enabled()) return;
  // the kill switch flipped mid-flight: cancel any resting limit so it
  // can never fill after the halt, and drop the pending cards quietly
  if (tradingHalted()) {
    for (const [key, e] of [...pending]) {
      if (e.limit?.orderId) {
        const c = await cancelOrder(e.limit.orderId);
        void logExec({ key, label: e.label, attempt: "watch", outcome: c.ok ? "limit_expired" : "limit_cancel_failed", reason: `trading halted — resting limit cancelled: ${c.reason}` });
      }
    }
    pending.clear();
    return;
  }
  if (pending.size === 0) return;
  const now = Date.now();
  let fills: Array<{ ts: number; action: string; qty: number; price: number }> | null = null;
  for (const [key, e] of [...pending]) {
    // signal window (owner rule): nothing is ever placed outside
    // Sunday 18:00 ET → Friday 16:00 ET (daily 16:00–18:00 halt Mon–Thu) —
    // entries stay pending and are dropped by the give-up clock once it
    // expires (no weekend re-send).
    if (!signalWindowOpen(now)) {
      // a resting limit must never survive the signal window closing —
      // cancel it (the give-up clock no longer runs while closed)
      if (e.limit?.orderId) {
        const c = await cancelOrder(e.limit.orderId);
        void logExec({ key, label: e.label, attempt: "watch", outcome: c.ok ? "limit_expired" : "limit_cancel_failed", reason: `window closed — ${c.reason}` });
      }
      continue;
    }
    if (!immediate && now - e.ts < CHECK_AFTER_MS) continue;
    if (now - e.ts > GIVE_UP_MS) {
      if (e.limit?.orderId) {
        const c = await cancelOrder(e.limit.orderId);
        void logExec({ key, label: e.label, attempt: "watch", outcome: c.ok ? "limit_cancelled_giveup" : "limit_cancel_failed", reason: c.reason });
      }
      pending.delete(key);
      if (!alerted.has(key) || e.sendFailed) {
        alerted.add(key);
        void alert(`⚠ <b>EXECUTION UNCONFIRMED</b> — <code>${e.label}</code> never confirmed after 10 min`);
      }
      continue;
    }
    fills = immediate ? await fetchFills(true) : (fills ?? (await fetchFills()));
    const matchedFill = fills ? findMatchingFill(e, fills, now) : null;
    if (matchedFill) {
      pending.delete(key);
      // telemetry: close the submit→fill leg with the broker's own fill
      // timestamp (lib/execLatency.ts — "time for CrossTrade to execute")
      noteOrderFill(e.intent.dir, e.intent.contracts, matchedFill.ts);
      // counter-gate tracking: an RTH entry just filled → note the open
      // position so the exit poll can log its winning exit on flat
      if (e.label.startsWith("rth ") && !e.scaleOut) {
        setOpenRthPos({ dir: e.intent.dir, entryPrice: e.intent.entry, at: now });
      }
      if (e.limit) {
        // the resting limit filled — the position exists, brackets are
        // exchange-side; register the profile time exit from the FILL time
        if (!e.scaleOut) {
          const prof = momentumProfile();
          if (prof.enabled) {
            registerTimeExit({
              key,
              label: e.label,
              symbol: e.intent.symbol,
              dir: e.intent.dir,
              exitAtMs: timeExitAt(now, prof),
            });
          }
        }
        void logExec({ key, label: e.label, attempt: "watch", outcome: "limit_filled", reason: "resting limit filled" });
        void alert(`✅ <b>LIMIT FILLED</b> — <code>${e.label}</code> resting limit entered`);
      }
      // protection verification on fill: a filled position must have a
      // working stop — the watchdog repairs (re-arm → flatten) if not
      void checkProtection().catch(() => {});
      continue;
    }

    // the IMMEDIATE (pushed-fill) pass only MATCHES fills — no match means
    // the fill hasn't hit the broker's fill list yet; the regular 5s
    // timer will confirm it. Never fall through to the re-send/drop
    // branches on an immediate pass (a just-placed card must not be
    // re-sent or given up early).
    if (immediate) continue;

    // resting-limit lifecycle: a limit card whose send succeeded waits for
    // the fill (no verify, no resend — the working order IS the intended
    // state) and is CANCELLED at its expiry. A limit must never outlive
    // the card that placed it.
    if (e.limit && !e.sendFailed) {
      if (now >= e.limit.expireAtMs) {
        pending.delete(key);
        const c = e.limit.orderId ? await cancelOrder(e.limit.orderId) : { ok: false, reason: "no order id — cannot cancel" };
        void logExec({ key, label: e.label, attempt: "watch", outcome: c.ok ? "limit_expired" : "limit_cancel_failed", reason: c.reason });
        void alert(
          c.ok
            ? `⏱ <b>LIMIT EXPIRED — cancelled</b> — <code>${e.label}</code> rested unfilled for ${Math.round((now - e.ts) / 1000)}s`
            : `🚨 <b>LIMIT EXPIRED BUT CANCEL FAILED</b> — <code>${e.label}</code> — ${c.reason} — cancel it manually NOW`,
        );
      }
      continue;
    }

    if (!autoRetry()) {
      if (!alerted.has(key)) {
        alerted.add(key);
        if (e.limit?.orderId) {
          const c = await cancelOrder(e.limit.orderId);
          void logExec({ key, label: e.label, attempt: "watch", outcome: c.ok ? "limit_expired" : "limit_cancel_failed", reason: `auto-retry off — ${c.reason}` });
        }
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
    if (
      e.limit &&
      (stopCrossedAtDispatch(e.intent.dir, e.intent.stop, currentTapeLtp()) === true ||
        limitCrossedAtDispatch(e.intent.dir, e.limit.price, currentTapeLtp()) === true)
    ) {
      // crossed-stop / crossed-limit gates: the tape moved through the
      // bracket — re-placing the limit would submit a stop leg Tradovate
      // rejects (naked fill) or a drifted fill with a compressed stop
      // (the 2026-10-08 incidents)
      pending.delete(key);
      void logExec({ key, label: e.label, attempt: "watch", outcome: "skipped_stale", reason: "tape crossed the stop/limit — limit re-send would place a broken bracket" });
      void alert(`⚠ <b>RE-SEND SKIPPED — tape through the bracket</b> — <code>${e.label}</code>\nthe tape moved through the stop/limit; re-placing would produce a naked fill or a compressed stop.`);
      continue;
    }
    const res = e.scaleOut ? await placeScaleOut(e.intent) : await placeOrder(e.intent, e.limit ? { limitPrice: e.limit.price } : {});
    e.attempts += 1;
    e.lastAttemptAt = now;
    if (res.ok && e.limit) {
      // limit re-placed — the resting-limit lifecycle takes over: wait for
      // the fill (time exit registers on fill, not on placement) or cancel
      // at expiry. The card stays pending. (The executor registered the
      // bracket and verified the legs itself — global invariant.)
      if ("orderId" in res && res.orderId) e.limit.orderId = res.orderId;
      void logExec({
        key,
        label: e.label,
        attempt: "resend",
        outcome: "resend_ok",
        reason: res.reason,
      });
      void alert(`🔁 <b>AUTO RE-SENT — limit resting</b> — <code>${e.label}</code> verified absent, re-sent (attempt ${e.attempts}/${MAX_RESEND_ATTEMPTS}): ${res.reason}`);
      continue;
    }
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
    if (res.reason.includes("trading halted")) {
      // the owner's kill switch — record quietly, never alarm
    } else {
      void alert(
        retryable
          ? `🚨 <b>RE-SEND GAVE UP</b> — <code>${e.label}</code> — ${MAX_RESEND_ATTEMPTS} verified attempts failed: ${res.reason}`
          : `🚨 <b>RE-SEND ABORTED</b> — <code>${e.label}</code> — ${res.reason} (not retryable)`,
      );
    }
  }
}

/** TEST ONLY: reset the watcher state. */
export function __resetExecWatchForTest() {
  pending = new Map();
  alerted = new Set();
  failedKeys = new Set();
  fillCache = null;
  setOpenProtection(null);
  setNakedAlerted(false);
  setNakedSince(null);
}
