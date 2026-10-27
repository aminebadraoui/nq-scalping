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
import { stopCrossedAtDispatch, limitCrossedAtDispatch, currentTapeLtp, repairNakedPosition, openProtection, setOpenProtection, reanchorBracketForFill, rearmCrossTradeBracketREST, type OpenProtection } from "./crossTrade";
import { tradingHalted } from "./tradingHalt";
import { momentumProfile, timeExitAt } from "./profile";
import { registerTimeExit } from "./timeExit";
import { getLive } from "./live";
import { logExec } from "./execLog";
import { noteOrderFill } from "./execLatency";
import { signalWindowOpen } from "./marketHours";
import { newsBlockedNow } from "./newsGate";
import { noteRthExit } from "./rthExitLog";
import { ctFetch, ctFills, ctOrders, ctPositions } from "./ctAccount";
import { trackExecRegister, trackExecFail, trackExecFill, trackExecClose, getExecTrades } from "./execTracker";
import { getMemoryHistory } from "./signalHistory";

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
  limit?: { orderId?: string; price: number; expireAtMs: number; quiet?: boolean };
};

const CHECK_AFTER_MS = 90_000;
const GIVE_UP_MS = 10 * 60_000;
const RETRY_INTERVAL_MS = 90_000;
const MAX_RESEND_ATTEMPTS = 3;
const MATCH_WINDOW_MS = 5 * 60_000;
const MNQ = "MNQ";

let pending = new Map<string, Expectation>();
/** limit order ids attached BEFORE the card registered (the placement
 *  resolve / registerExpectation race) — applied on registration. */
const pendingLimitIds = new Map<string, string>();
/** closed-window cancel throttle: card key → last cancel attempt (ms) */
const windowCancelAt = new Map<string, number>();
const WINDOW_CANCEL_RETRY_MS = 60_000;
let alerted = new Set<string>();
let failedKeys = new Set<string>();

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
  // shared read layer (ctAccount) — always fresh, identical endpoint
  return ctOrders();
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
async function fetchPositionsCached(): Promise<Array<Record<string, unknown>> | null> {
  // shared read layer (ctAccount) — the same 2s TTL, same endpoint
  return ctPositions();
}

/** signed MNQ position from the fill-reconciled read — but NEVER collapse
 *  "unreadable" into "flat" (2026-10-15 naked-stop incident: the degraded
 *  positions endpoint read empty/flat all afternoon while an 8-lot short
 *  ran unprotected, and the watchdog cleared the protection on that "flat"
 *  read and went silent). Callers get a discriminated result. */
type MnqPositionRead =
  | { status: "flat" }
  | { status: "open"; qty: number; dir: "long" | "short" }
  | { status: "unreadable" };

async function readMnqPositionRead(): Promise<MnqPositionRead> {
  const rows = await fetchPositionsCached();
  if (rows === null) return { status: "unreadable" };
  let qty = 0;
  for (const p of rows) {
    if (!String(p.instrument ?? p.contractName ?? "").includes(MNQ)) continue;
    qty += Number(p.netPos ?? p.qty ?? 0);
  }
  if (qty === 0) return { status: "flat" };
  return { status: "open", qty, dir: qty > 0 ? "long" : "short" };
}

/** the exit-fill window for the slippage alarm (2026-10-12 recurrence):
 *  the fills stream is not account-scoped and carries multi-day history.
 *  After the 2026-10-11 account switch, "last fill ever" compared a flat
 *  transition on a 30885 tape against Friday's 31185.25 fill and raised
 *  275.6/308.3-pt phantom slips. A fill outside this window cannot be
 *  today's exit. */
export const EXIT_SLIP_WINDOW_MS = 15 * 60_000;

/** pure exit-fill picker for the slippage alarm: the LAST opposite-side
 *  fill inside the exit window, or null (no phantom alarm on stale
 *  history). Unit-tested. */
export function pickExitFill(
  fills: Array<{ ts: number; action: string; qty: number; price?: number }>,
  dir: "long" | "short",
  now: number,
  windowMs: number = EXIT_SLIP_WINDOW_MS,
): { ts: number; action: string; qty: number; price?: number } | null {
  const want = dir === "long" ? "Sell" : "Buy";
  const exits = fills.filter((f) => f.action === want && Number.isFinite(f.ts) && f.ts <= now && f.ts >= now - windowMs);
  if (!exits.length) return null;
  exits.sort((a, b) => a.ts - b.ts);
  return exits[exits.length - 1];
}

/** stop-slippage alarm (2026-10-08 −$1,056 event): when a tracked trade
 *  goes flat, compare the exit fill against the intended stop. A fill
 *  far beyond the stop means the stop-market chased a gap — the risk
 *  model priced the stop at its trigger, and reality disagreed. Alert +
 *  journal so execution quality is visible, not just P&L. */
async function checkExitSlippage(intent: OrderIntent): Promise<void> {
  const fills = await fetchFills();
  const exit = pickExitFill(fills, intent.dir, Date.now());
  if (!exit || exit.price === undefined) return;
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
/** one protection poll must never release the registry on a single "flat"
 *  read (2026-10-15): either an opposite-side exit fill covering the entry
 *  proves the close, or the flat claim persists across two polls. */
const FLAT_CLAIM_PERSIST_MS = 20_000; // two 10s polls
let flatClaimReg: OpenProtection | null = null;
let flatClaimSeenAt = 0;
let protectionBookUnreadableAlerted = false;

async function flatClaimSupported(reg: OpenProtection): Promise<boolean> {
  // strongest evidence: the broker's own fills show the exit leg
  const fills = await ctFills();
  if (fills && fills.length > 0) {
    const want = reg.intent.dir === "long" ? "Sell" : "Buy";
    const need = Math.max(1, Math.floor(reg.intent.contracts * 0.8));
    const exitQty = fills.filter((f) => f.action === want && f.ts >= reg.at - 5_000).reduce((s, f) => s + f.qty, 0);
    if (exitQty >= need) return true;
  }
  // weaker evidence: the flat positions read persisting across two polls
  const now = Date.now();
  if (flatClaimReg !== reg) {
    flatClaimReg = reg;
    flatClaimSeenAt = now;
    return false;
  }
  return now - flatClaimSeenAt >= FLAT_CLAIM_PERSIST_MS;
}

/**
 * Does the protection sweep have anything to protect? ZERO book
 * polling while flat (2026-10-16 owner directive): with nothing
 * tracked and nothing in flight, the sweep never reads the broker.
 * The flat gate still reads FRESH at every card (fail-closed on an
 * open position), and our own placements register expectations BEFORE
 * dispatch — so `tracked` becomes true the moment a position can
 * exist and the sweep resumes at full cadence instantly. Manual
 * positions are the owner's responsibility while flat. Pure —
 * unit-tested.
 */
export function protectionSweepDue(tracked: boolean): boolean {
  return tracked;
}

export async function checkProtection(): Promise<void> {
  if (!enabled()) return;
  const tracked = openProtection() !== null || openExecs().size > 0 || pending.size > 0;
  if (!protectionSweepDue(tracked)) return;
  const read = await readMnqPositionRead();
  const reg = openProtection();
  if (read.status === "unreadable") {
    // 2026-10-15: unreadable must NEVER look like flat. Keep the
    // registry armed and page the operator — a tracked entry may be
    // open and unprotected right now.
    if (reg && !protectionBookUnreadableAlerted) {
      protectionBookUnreadableAlerted = true;
      void alert(
        `⚠️ <b>PROTECTION BOOK UNREADABLE</b> — a tracked entry (<code>${reg.intent.dir} ${reg.intent.contracts} MNQ</code>) may be open and the positions endpoint cannot confirm or deny it — the watchdog stays armed and verifies continuously.`,
      );
    }
    return;
  }
  if (read.status === "flat") {
    protectionBookUnreadableAlerted = false;
    if (reg) {
      // a flat claim while a tracked bracket could be open needs proof
      // (exit fills) or persistence — otherwise keep the registry armed
      // and verify again next poll (never silently release)
      if (!(await flatClaimSupported(reg))) return;
      // flat transition confirmed — the trade just exited. If the exit
      // fill landed far beyond the intended stop (gap-through slippage,
      // the 2026-10-08 −$1,056 event), scream: the risk model needs to
      // know its stop fills are not landing where they were priced.
      void checkExitSlippage(reg.intent);
      setOpenProtection(null); // flat — the entry closed or expired
    }
    // a confirmed-flat book ends any naked episode: without this, the
    // stale timer (or the post-repair now+cooldown stamp) carried over to
    // the NEXT trade, whose first check — run at the fill, inside the
    // sub-second OSO activation window — then "repaired" a healthy
    // bracket immediately; a stale nakedAlerted also muted the next
    // UNTRACKED alert
    setNakedSince(null);
    setNakedAlerted(false);
    return;
  }
  // position open: reset the unreadable latch + the flat-claim window so
  // a later flat claim must re-prove itself from scratch
  protectionBookUnreadableAlerted = false;
  flatClaimSeenAt = 0;
  if (!reg || reg.intent.dir !== read.dir) {
    if (reg) {
      // the tracked trade is gone (the open position is on the other
      // side): its naked timer must not carry over either
      setOpenProtection(null);
      setNakedSince(null);
    }
    if (!nakedAlerted()) {
      setNakedAlerted(true);
      void logExec({
        key: `protect|${Date.now()}`,
        label: "protection watchdog",
        attempt: "watch",
        outcome: "naked_untracked",
        reason: `MNQ position ${read.dir} open with no tracked bracket — verify manually`,
      });
      void alert(`⚠️ <b>UNTRACKED MNQ POSITION OPEN</b> — ${read.dir} ${read.qty} with no bracket we placed — verify manually (never auto-touched).`);
    }
    return;
  }
  const ws = await findWorkingStop(read.dir);
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
      label: `protection watchdog ${read.dir}`,
      attempt: "watch",
      outcome: "stop_missing",
      reason: "position open with no working stop",
    });
    void alert(`🚨 <b>NO WORKING STOP ON OPEN POSITION</b> — ${read.dir} ${read.qty} MNQ — re-arming in ~30s if it persists (flatten fallback).`);
    return;
  }
  if (Date.now() - since < NAKED_PERSIST_MS) return;
  void repairNakedPosition(reg.intent, `protection watchdog ${read.dir}`, `protect|${Date.now()}`);
  // retry on a cooldown while the position stays naked (repair alerts)
  setNakedSince(Date.now() + REPAIR_COOLDOWN_MS);
}

/* ---- open-exec tracking (feeds the execution ledger) ----------------- *
 * Bracket exits are exchange-side — the system never sees the exit fill
 * directly. Every confirmed entry is noted here, and a 30s poll detects
 * the flat transition; the opposite-side session fills since the entry
 * are the exit leg → pts/$ result → lib/execTracker.ts (the live
 * signal→Tradovate→P&L view). RTH labels additionally feed the
 * counter-signal gate via lib/rthExitLog. It can only ever SKIP a later
 * card via the feed's counter-gate — never place or change one. */

type OpenExec = { key: string; label: string; dir: "long" | "short"; entryPrice: number; at: number; orderId: string; intent: OrderIntent };

const gp = globalThis as unknown as { __gcOpenExecs?: Map<string, OpenExec> | null };
function openExecs(): Map<string, OpenExec> {
  if (!gp.__gcOpenExecs) gp.__gcOpenExecs = new Map();
  return gp.__gcOpenExecs;
}

/** signed net MNQ position, or null when the book is unreadable. Uses
 *  the same reader as the protection watchdog (netPos, then qty) — this
 *  one used to read `qty ?? quantity` only, so netPos-only rows (the
 *  shape every other reader and the WS mirror use) read as flat, and a
 *  real 1-lot short (-1) collided with the old -1 "unreadable" sentinel. */
async function readMnqHeld(): Promise<number | null> {
  const r = await readMnqPositionRead();
  if (r.status === "unreadable") return null;
  if (r.status === "flat") return 0;
  return r.qty;
}

/** pure exit-leg picker for the flat-transition poll (2026-10-13
 *  momentum fast-OCO scramble): the bracket's exit fills, by priority —
 *    1. opposite-side fills on the card's OWN entry orderId (the fast
 *       OCO round trip — CrossTrade prints the flatten fill on the entry
 *       order), then
 *    2. the FIRST opposite-side fills after the entry FILL, in time
 *       order, until the cumulative qty reaches the entry size.
 *  A fill whose single qty EXCEEDS the entry size cannot be this card's
 *  exit leg (bracket exits are exact-size — a 25-lot fill on an 8-lot
 *  card is someone else's round trip), and a fill on ANOTHER card's
 *  entry orderId belongs to that card. Returns the original fill rows
 *  (fees ride along); [] = nothing qualifies, the caller keeps the row
 *  open. Generic so tests pass bare rows. */
export function pollExitFills<T extends { ts: number; action: string; qty: number; price?: number; orderId?: string }>(
  fills: T[],
  at: number,
  want: "Buy" | "Sell",
  contracts: number,
  ownOrderId: string,
  otherEntryOrderIds: Set<string>,
): T[] {
  const chrono = [...fills].sort((a, b) => a.ts - b.ts);
  const walk = (src: T[]): { out: T[]; qty: number } => {
    const out: T[] = [];
    let qty = 0;
    for (const f of src) {
      if (f.ts <= at) continue;
      if (f.action !== want) continue;
      if (f.qty > contracts) continue; // cannot be this card's exit leg
      if (f.orderId && otherEntryOrderIds.has(f.orderId)) continue; // another card's entry
      out.push(f);
      qty += f.qty;
      if (qty >= contracts) break;
    }
    return { out, qty };
  };
  if (ownOrderId) {
    const own = walk(chrono.filter((f) => f.orderId === ownOrderId));
    if (own.qty >= contracts) return own.out;
  }
  return walk(chrono).out;
}

async function pollRthExit(): Promise<void> {
  const execs = openExecs();
  if (execs.size === 0) return;
  const held = await readMnqHeld();
  if (held !== 0) return; // still open (or unreadable — retry next poll)
  // flat transition: attribute each card's exit leg from its OWN entry
  // fill forward — qty-bounded, never another card's exit or a manual
  // leg (the 2026-10-13 momentum scramble: an 8-lot same-second OCO exit
  // was attributed to the 7-lot card before it, and a 25-lot manual fill
  // to the 8-lot card after it).
  const full = await ctFills();
  if (full === null) return;
  const nowMs = Date.now();
  const entries = [...execs.values()].sort((a, b) => a.at - b.at);
  const entryOrderIds = new Set(entries.map((p) => p.orderId).filter(Boolean));
  for (const pos of entries) {
    const want = pos.dir === "long" ? "Sell" : "Buy";
    const others = new Set(entryOrderIds);
    others.delete(pos.orderId);
    const exits = pollExitFills(full, pos.at, want, pos.intent.contracts, pos.orderId, others);
    const qty = exits.reduce((s, f) => s + f.qty, 0);
    if (qty <= 0) {
      // flat but no qualifying exit fills (fill-list lag, a session
      // reset, or the exit was a manual/other leg) — keep retrying,
      // then drop after 4h (the nightly reconcile stays the authority)
      if (nowMs - pos.at > 4 * 60 * 60_000) execs.delete(pos.key);
      continue;
    }
    execs.delete(pos.key);
    const exitAvg = exits.reduce((s, f) => s + f.price! * f.qty, 0) / qty;
    const realFees = exits.reduce((s, f) => s + f.commission + f.fees, 0);
    // the execution ledger: close the row with the $ result (display-only)
    void trackExecClose(pos.key, {
      entry: pos.entryPrice,
      dir: pos.dir,
      contracts: pos.intent.contracts,
      exitFills: exits.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price })),
      realFees,
    });
    const pts = (exitAvg - pos.entryPrice) * (pos.dir === "long" ? 1 : -1);
    if (pts > 0 && (pos.label.startsWith("session-continuation ") || pos.label.startsWith("rth "))) {
      noteRthExit(pos.dir, exitAvg, Date.now());
      console.log(`[rth-exit] ${pos.dir.toUpperCase()} winner logged — exit ${exitAvg.toFixed(2)} (+${pts.toFixed(1)} pts from signal ${pos.entryPrice.toFixed(2)})`);
    }
  }
}

let exitPollStarted = false;

/* ---- orphan ledger reconciliation (2026-10-13 10:16 incident) ------- *
 * A resting limit can fill AFTER the entry-match window closes or after
 * a redeploy wiped the in-memory pending/openExec registries — the fill
 * and stop then happen with no watcher attached and exec_trades stays
 * "placed" until the nightly reconcile. This sweep re-attaches such rows
 * to the broker's fill list: entry fill → "filled" (+ order id), and
 * when the account is flat, the opposite-side fills since the entry →
 * "closed" with the $ result. DISPLAY-ONLY: it never touches orders,
 * never registers openExecs, and never feeds the protection watchdog or
 * the counter-signal gate (those stay in-process only). Throttled; rows
 * younger than ORPHAN_MIN_AGE_MS wait for the live paths to act first. */
let lastOrphanSweepAt = 0;
const ORPHAN_SWEEP_INTERVAL_MS = 30_000;
const ORPHAN_MIN_AGE_MS = 90_000;
const ORPHAN_MATCH_WINDOW_MS = 15 * 60_000;
const ORPHAN_ENTRY_PRICE_TOLERANCE_PTS = 6;
/** a confident close needs the bracket's own exit fills — the FIRST
 *  opposite-side fills after the entry summing to the entry size, within
 *  minutes of it. Beyond that horizon manual trading interleaves and the
 *  attribution is ambiguous (the nightly reconcile stays the authority). */
const ORPHAN_CLOSE_HORIZON_MS = 5 * 60_000;

/** pure exit-leg picker for the orphan sweep: opposite-side fills after
 *  the entry fill, in time order, until the cumulative qty reaches the
 *  entry size (reconcile's qty-bounded semantics) or the horizon ends.
 *  Generic so the caller keeps the full fill row (price/fees). */
export function bracketExitFills<T extends { ts: number; action: string; qty: number }>(
  fills: T[],
  entryTs: number,
  exitAction: "Buy" | "Sell",
  contracts: number,
  horizonMs: number,
): T[] {
  const out: T[] = [];
  let qty = 0;
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    if (f.ts <= entryTs) continue;
    if (f.ts > entryTs + horizonMs) break;
    if (f.action !== exitAction) continue;
    if (f.qty > contracts) continue; // a single fill larger than the entry is not this card's exit leg (2026-10-13: a 25-lot manual fill vs an 8-lot card)
    out.push(f);
    qty += f.qty;
    if (qty >= contracts) break;
  }
  return out;
}

export async function sweepOrphanLedger(opts?: { nowMs?: number }): Promise<void> {
  if (!enabled()) return;
  const now = opts?.nowMs ?? Date.now();
  if (now - lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return;
  lastOrphanSweepAt = now;
  const today = nyDay(now);
  const yesterday = nyDay(now - 24 * 60 * 60_000);
  const rows = await getExecTrades(120);
  // "placed"-only: rows the live process ALREADY marked "filled" have a
  // known entry but an exit it failed to track — with manual trading on
  // the account that attribution is ambiguous, so they wait for the
  // nightly reconcile. The sweep targets the full-invisibility case
  // (2026-10-13 10:16: fill AND stop happened with no watcher attached).
  const candidates = rows.filter(
    (r) =>
      (r.day === today || r.day === yesterday) &&
      r.status === "placed" &&
      now - r.ts > ORPHAN_MIN_AGE_MS &&
      !pending.has(r.key) &&
      !openExecs().has(r.key),
  );
  if (candidates.length === 0) return;
  const fills = await ctFills();
  if (fills === null || fills.length === 0) return;
  const held = await readMnqHeld();
  if (held === null) return; // positions unreadable — never guess
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  for (const row of candidates) {
    const want = row.side === "long" ? "Buy" : "Sell";
    const need = Math.max(1, Math.floor(row.contracts * 0.8));
    const entries = sorted.filter(
      (f) =>
        f.action === want &&
        f.qty >= need &&
        f.ts >= row.ts - 10_000 &&
        f.ts <= row.ts + ORPHAN_MATCH_WINDOW_MS &&
        Number.isFinite(f.price) &&
        Math.abs(f.price - row.sigEntry) <= ORPHAN_ENTRY_PRICE_TOLERANCE_PTS,
    );
    if (entries.length === 0) continue;
    const ef = entries[entries.length - 1];
    void trackExecFill(row.key, { ts: ef.ts, action: ef.action, qty: ef.qty, price: ef.price }, sorted);
    void logExec({
      key: row.key,
      label: row.label,
      attempt: "watch",
      outcome: "fill_reconciled",
      reason: `orphan sweep matched a late entry fill at ${ef.price.toFixed(2)}`,
    });
    if (held !== 0) continue; // position still open — the entry stands, the close waits
    const exits = bracketExitFills(sorted, ef.ts, row.side === "long" ? "Sell" : "Buy", row.contracts, ORPHAN_CLOSE_HORIZON_MS);
    const exitQty = exits.reduce((s, f) => s + f.qty, 0);
    if (exitQty < need) continue; // no confident exit leg — leave for reconcile
    void trackExecClose(row.key, {
      entry: row.sigEntry,
      dir: row.side,
      contracts: row.contracts,
      exitFills: exits.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price })),
      realFees: exits.reduce((s, f) => s + f.commission + f.fees, 0),
    });
    void logExec({
      key: row.key,
      label: row.label,
      attempt: "watch",
      outcome: "close_reconciled",
      reason: `orphan sweep closed the row from ${exits.length} exit fill(s) within ${Math.round((exits[exits.length - 1].ts - ef.ts) / 1000)}s of the entry`,
    });
  }
}

/** 30s broker poll that turns flat transitions into execution-ledger
 *  closes (exit fills → $ result; RTH labels also feed the
 *  counter-signal gate), runs the protection watchdog
 *  (working-stop verification + naked-position repair), and reconciles
 *  orphan ledger rows (late limit fills / redeploy survivors).
 *  Started from instrumentation. */
export function startRthExitPoll(intervalMs = 10_000): void {
  if (exitPollStarted || !enabled()) return;
  exitPollStarted = true;
  setInterval(() => {
    void pollRthExit().catch(() => {});
    void checkProtection().catch(() => {});
    void sweepOrphanLedger().catch(() => {});
  }, intervalMs);
  // boot evidence (2026-10-12): the verified-resend machinery has never
  // produced a resend row in exec_log — this line proves on the VPS that
  // the exit/protection poll actually started.
  console.log(`[execWatch] exit/protection poll started (${intervalMs / 1000}s)`);
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
  // boot evidence (2026-10-12): proves on the VPS that the fill-watch /
  // verified-resend timer actually started.
  console.log(`[execWatch] fill-watch timer started (${intervalMs / 1000}s)`);
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

async function fetchFills(force = false): Promise<Array<{ ts: number; action: string; qty: number; price: number; orderId: string }>> {
  // shared read layer (ctAccount) — same 5s window, same fallback shape
  // (orderId rides along: the exit poll + openExec registration need it
  // to separate one card's fills from another's — 2026-10-13 scramble)
  const full = await ctFills({ force });
  if (full === null) return [];
  return full.map((f) => ({ ts: f.ts, action: f.action, qty: f.qty, price: f.price, orderId: f.orderId }));
}

/** fill match: the trade side printed >= 80% of the contracts within the window */
export function fillMatches(
  e: { ts: number; intent: { dir: "long" | "short"; contracts: number } },
  fills: Array<{ ts: number; action: string; qty: number; price?: number }>,
  now: number,
): boolean {
  return findMatchingFill(e, fills, now) !== null;
}

/** a resting-limit fill may print farther from the limit than this and
 *  still be ours (the live RTH fills drifted +1.62/+3.62/+2.75 pts past
 *  the limit price on the better side); beyond it the fill is far more
 *  likely someone else's order on the account (manual trading) — the
 *  price check is what makes the extended limit window safe. */
const LIMIT_FILL_TOLERANCE_PTS = 5;

/** the matched entry fill (with its price) — null when no fill matches.
 *  The fill PRICE is the execution-quality input for the re-anchor and
 *  slippage checks: it is where the trade actually got in, not the signal.
 *  `opts` extends the match for resting-limit cards (2026-10-13 10:16
 *  incident): a limit is DESIGNED to wait — the default 5-minute window
 *  expires before the limit's own TTL, so a fill between window-end and
 *  expiry was invisible (no ledger fill, no open-exec, the expiry cancel
 *  then failed against an already-filled order). For limit cards the
 *  window runs to the limit's expiry (bounded by the give-up clock) and
 *  the fill must sit within LIMIT_FILL_TOLERANCE_PTS of the limit price. */
export function findMatchingFill(
  e: { ts: number; intent: { dir: "long" | "short"; contracts: number } },
  fills: Array<{ ts: number; action: string; qty: number; price?: number; orderId?: string }>,
  now: number,
  opts?: { upperBoundMs?: number; limitPrice?: number },
): { ts: number; action: string; qty: number; price?: number; orderId?: string } | null {
  const want = e.intent.dir === "long" ? "Buy" : "Sell";
  const need = Math.max(1, Math.floor(e.intent.contracts * 0.8));
  const upper = opts?.upperBoundMs ?? e.ts + MATCH_WINDOW_MS;
  const matches = fills.filter(
    (f) =>
      f.action === want &&
      f.qty >= need &&
      f.ts >= e.ts - 10_000 &&
      f.ts <= upper &&
      (opts?.limitPrice === undefined ||
        (typeof f.price === "number" && Number.isFinite(f.price) && Math.abs(f.price - opts.limitPrice) <= LIMIT_FILL_TOLERANCE_PTS)),
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
export async function verifyAbsent(opts?: { fetchFn?: typeof fetch }): Promise<{ clean: boolean; reason: string }> {
  const key = process.env.CROSSTRADE_KEY ?? "";
  const account = process.env.CROSSTRADE_ACCOUNT ?? "";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const fetchFn = opts?.fetchFn ?? fetch;
  try {
    // working orders on the account (a placed-but-unfilled order lives here).
    // Pacing-aware (2026-10-12): broker_rate_limited refusals retry with
    // backoff via ctFetch instead of aborting the verified re-send.
    const ordRes = await ctFetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/orders`,
      { headers, signal: AbortSignal.timeout(30_000) },
      { extraRetries: 2, retryOn503: true },
      fetchFn,
    );
    const ordJ = JSON.parse(ordRes.text) as { success?: boolean; error?: string; data?: Array<Record<string, unknown>> };
    if (!ordJ.success) return { clean: false, reason: `orders read failed: ${String(ordJ.error ?? "")}` };
    const working = (ordJ.data ?? []).filter((o) =>
      String(o.instrument ?? o.contractName ?? "").includes(MNQ),
    );
    if (working.length > 0) return { clean: false, reason: `${working.length} working MNQ order(s) — likely placed` };

    // positions (fill-reconciled): the ultimate truth — a filled order shows here
    const posRes = await ctFetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/positions`,
      { headers, signal: AbortSignal.timeout(30_000) },
      { extraRetries: 2, retryOn503: true },
      fetchFn,
    );
    const posJ = JSON.parse(posRes.text) as { success?: boolean; error?: string; data?: Array<Record<string, unknown>> };
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

/** New York calendar date for an epoch ms timestamp. */
function nyDay(ts: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ts));
    const g: Record<string, string> = {};
    for (const p of parts) g[p.type] = p.value;
    return `${g.year}-${g.month}-${g.day}`;
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** link the just-registered card to the signal record that produced it:
 *  the in-process signal history holds the card (recorded right before
 *  registerExpectation in the feed) — match on side + timeET + entry
 *  price. "" when nothing matches (the ledger still tracks by card key). */
function resolveSignalId(e: { ts: number; intent: OrderIntent }): string {
  try {
    const recent = getMemoryHistory(60).filter(
      (s) =>
        s.side === e.intent.dir &&
        s.timeET === e.intent.timeET &&
        Number.isFinite(s.price) &&
        Math.abs(s.price - e.intent.entry) <= 1 &&
        Math.abs(s.ts - e.ts) <= 5 * 60_000,
    );
    return recent[0]?.id ?? "";
  } catch {
    return "";
  }
}

/** register a just-sent trade card (no-op when not live) */
export function registerExpectation(e: Omit<Expectation, "sendFailed" | "attempts" | "lastAttemptAt">) {
  if (!enabled()) return;
  // the owner's kill switch: the card is info-only — nothing is placed,
  // so the watcher has nothing to verify, re-send, or alarm about
  if (tradingHalted()) return;
  pending.set(e.key, { ...e, sendFailed: failedKeys.has(e.key), attempts: 0, lastAttemptAt: 0 });
  // an order id attached BEFORE this card registered (the placement
  // promise resolved first) lands now — the expiry cancel must be able
  // to address the resting limit it placed
  const parkedId = pendingLimitIds.get(e.key);
  if (parkedId && e.limit) {
    e.limit.orderId = parkedId;
    pendingLimitIds.delete(e.key);
  }
  // execution ledger (display-only telemetry — never affects placement).
  // Scale-out legs are partial-exit children of the base entry card: the
  // ledger tracks the base trade; the nightly reconcile books the splits.
  if (!e.scaleOut) {
    void trackExecRegister({
      key: e.key,
      ts: e.ts,
      day: nyDay(e.ts),
      label: e.label,
      dir: e.intent.dir,
      contracts: e.intent.contracts,
      entry: e.intent.entry,
      stop: e.intent.stop,
      target: e.intent.target,
      timeET: e.intent.timeET,
      signalId: resolveSignalId(e),
    });
  }
}

/** attach the broker-facing order id to a pending limit card after its
 *  placement returns (the id is ours by construction, so this is how the
 *  expiry cancel addresses the order). No-op when not live.
 *
 *  RACE (2026-10-13 10:16 incident): the placement promise can resolve
 *  BEFORE the feed's registerExpectation (which awaits the Telegram push
 *  + signal record first) — the id then had no pending entry to land on
 *  and was silently dropped. The card expired with "no order id — cannot
 *  cancel" and the resting limit outlived its card. The id now parks in
 *  pendingLimitIds and registerExpectation applies it whenever the card
 *  registers — order-independent. */
export function attachLimitOrderId(key: string, orderId: string) {
  if (!enabled()) return;
  const e = pending.get(key);
  if (e?.limit) e.limit.orderId = orderId;
  else pendingLimitIds.set(key, orderId);
}

/** the broker-facing order ids WE placed (resting-limit entries) — the
 *  manual-action detector excludes them (display-only read). */
export function placedLimitOrderIds(): string[] {
  const out: string[] = [];
  for (const e of pending.values()) {
    if (e.limit?.orderId) out.push(e.limit.orderId);
  }
  return out;
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

/** pure expiry-cancel verdict (unit-tested): a failed cancel whose order
 *  id is ABSENT from a SUCCESSFUL order-list read means the order was
 *  already removed broker-side (e.g. a vendor-scheduled cancel fired
 *  first) — expired-clean, not a failure. An unreadable book (ok=false)
 *  or a still-present order keeps the failure (fail closed). */
export function expiryCancelVerdict(
  cancelOk: boolean,
  cancelReason: string,
  bookRead: { ok: boolean; orders: Array<Record<string, unknown>> },
  orderId: string,
): { outcome: "limit_expired" | "limit_cancel_failed"; reason: string } {
  if (cancelOk) return { outcome: "limit_expired", reason: cancelReason };
  if (orderId && bookRead.ok && !bookRead.orders.some((o) => String(o.orderId ?? o.clOrdId ?? o.id ?? "") === orderId)) {
    return { outcome: "limit_expired", reason: `${cancelReason} — order already gone broker-side` };
  }
  return { outcome: "limit_cancel_failed", reason: cancelReason };
}

/** a place-attempt returned not-ok: alert immediately. With verified
 *  retry armed, the card stays registered so the 90s check re-sends it
 *  after the broker verification. */
export function registerSendFailure(key: string, label: string, reason: string) {  if (!enabled()) return;
  if (reason.includes("trading halted")) return; // the owner's kill switch — intentional, not a failure to alarm about
  if (alerted.has(key)) return;
  failedKeys.add(key);
  void trackExecFail(key, reason); // execution ledger: mark the card failed
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
 *  dropped or re-sent early. `nowMs` is a test hook (defaults to now). */
export async function checkExpectations(opts?: { immediate?: boolean; nowMs?: number }): Promise<void> {
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

async function checkExpectationsOnce(opts?: { immediate?: boolean; nowMs?: number }): Promise<void> {
  const immediate = opts?.immediate === true;
  if (!enabled()) return;
  const now = opts?.nowMs ?? Date.now();
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
        // once per card, not every 5s tick: the old loop re-cancelled
        // (and re-logged) the same order every poll for the whole halt /
        // weekend, burning the CrossTrade pacing budget the protection
        // reads share. A failed cancel retries at most once a minute.
        const last = windowCancelAt.get(key) ?? 0;
        if (now - last < WINDOW_CANCEL_RETRY_MS) continue;
        windowCancelAt.set(key, now);
        const c = await cancelOrder(e.limit.orderId);
        const book = c.ok ? { ok: true, orders: [] as Record<string, unknown>[] } : await ctOrders();
        const v = expiryCancelVerdict(c.ok, `window closed — ${c.reason}`, book, e.limit.orderId);
        void logExec({ key, label: e.label, attempt: "watch", outcome: v.outcome, reason: v.reason });
        if (v.outcome === "limit_expired") {
          // the limit is gone — it can never fill, so the card is done
          pending.delete(key);
          windowCancelAt.delete(key);
        }
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
    const matchedFill = fills
      ? findMatchingFill(
          e,
          fills,
          now,
          e.limit ? { upperBoundMs: Math.min(e.limit.expireAtMs, e.ts + GIVE_UP_MS), limitPrice: e.limit.price } : undefined,
        )
      : null;
    if (matchedFill) {
      pending.delete(key);
      // telemetry: close the submit→fill leg with the broker's own fill
      // timestamp (lib/execLatency.ts — "time for CrossTrade to execute")
      noteOrderFill(e.intent.dir, e.intent.contracts, matchedFill.ts);
      // open-exec tracking: every confirmed entry is noted so the exit
      // poll can close its execution-ledger row on the flat transition
      // (RTH labels additionally feed the counter-signal gate).
      // `at` is the FILL time, not the confirmation time: a fast OCO can
      // exit the position BEFORE this confirmation lands (2026-10-13
      // 18:20: fill 18:21:11, protection flatten 18:22:44, confirmation
      // 18:23:33) — anchoring at the confirmation time hid the real exit
      // and the poll later attributed a LATER card's fill instead.
      if (!e.scaleOut) {
        openExecs().set(key, {
          key,
          label: e.label,
          dir: e.intent.dir,
          entryPrice: e.intent.entry,
          at: matchedFill.ts,
          orderId: matchedFill.orderId ?? "",
          intent: e.intent,
        });
      }
      // execution ledger: attach the broker's entry fill + Tradovate
      // order id (display-only telemetry — never affects the order)
      if (typeof matchedFill.price === "number" && Number.isFinite(matchedFill.price)) {
        void trackExecFill(
          key,
          { ts: matchedFill.ts, action: matchedFill.action, qty: matchedFill.qty, price: matchedFill.price },
          await ctFills(),
        );
      }
      if (e.limit) {
        // the resting limit filled — the position exists, brackets are
        // exchange-side; register the profile time exit from the FILL time
        if (!e.scaleOut) {
          const prof = momentumProfile();
          // VWAP-UP holds to its own 15:59 ET exit, not the momentum profile's
          if (prof.enabled && !key.startsWith("vwap|")) {
            registerTimeExit({
              key,
              label: e.label,
              symbol: e.intent.symbol,
              dir: e.intent.dir,
              // from the FILL time as documented — `now` is the confirm
              // time, which lagged the fill by up to the confirm delay
              exitAtMs: timeExitAt(Number.isFinite(matchedFill.ts) && matchedFill.ts > 0 ? matchedFill.ts : now, prof),
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
        // 2026-10-12: a failed cancel whose order id is ABSENT from a
        // successful order-list read is "already gone broker-side" (e.g. a
        // vendor-scheduled cancel fired first) — treat as expired, not as
        // a panic. An unreadable book still panics (fail closed).
        const book = e.limit.orderId ? await ctOrders() : { ok: false, orders: [] as Record<string, unknown>[] };
        const v = expiryCancelVerdict(c.ok, c.reason, book, e.limit.orderId ?? "");
        void logExec({ key, label: e.label, attempt: "watch", outcome: v.outcome, reason: v.reason });
        // per-bar re-armed limits (VWAP-UP) expire every minute by design —
        // only a FAILED cancel pages the owner
        if (!(e.limit.quiet && v.outcome === "limit_expired")) void alert(
          v.outcome === "limit_expired"
            ? `⏱ <b>LIMIT EXPIRED — cancelled</b> — <code>${e.label}</code> rested unfilled for ${Math.round((now - e.ts) / 1000)}s${c.ok ? "" : " (already gone broker-side)"}`
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
  pendingLimitIds.clear();
  windowCancelAt.clear();
  alerted = new Set();
  failedKeys = new Set();
  openExecs().clear();
  setOpenProtection(null);
  setNakedAlerted(false);
  setNakedSince(null);
}
