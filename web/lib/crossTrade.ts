/* ------------------------------------------------------------------ *
 * CrossTrade executor — places trade orders on the MFF Tradovate
 * account via the CrossTrade cloud webhook. No Tradovate API key is
 * needed on our side: CrossTrade is an approved Tradovate OAuth
 * partner and routes server-side; the linked account is addressed
 * with `destination=tradovate` and the order is flagged isAutomated
 * by them. No browser, no VPS, no NinjaTrader install — one HTTP POST
 * from the signal feed at the moment the card fires.
 *
 * This is the ONLY execution path — the former Playwright browser path
 * (lib/executor.ts) was removed. The same EXECUTE_LIVE gate applies:
 * dry-run (log only) until EXECUTE_LIVE=1.
 *
 * Brackets: stop_loss / take_profit are sent in TICKS (MNQ tick =
 * 0.25 pt). CrossTrade snapshots the live reference quote when the
 * webhook arrives and submits ABSOLUTE stop/target prices to
 * Tradovate, so the bracket is managed exchange-side from the fill —
 * the feed never has to manage exits.
 *
 * Exactly-once caveat (per CrossTrade docs): a success response is an
 * acknowledgement, not a fill confirmation, and a network timeout does
 * NOT establish whether the order was placed. This module never
 * retries on its own — on timeout it reports the order as UNKNOWN and
 * the operator verifies Alert History before acting. A duplicated
 * order is worse than a missed one.
 *
 * Env (web/.env.local locally, Coolify app env on the VPS):
 *   CROSSTRADE_URL          the personal webhook URL (My Account page):
 *                           https://app.crosstrade.io/v1/send/<uid>/<channel>
 *   CROSSTRADE_KEY          the Secret Key (My Account page)
 *   CROSSTRADE_ACCOUNT      the linked Tradovate account name as shown
 *                           in CrossTrade (e.g. the MFF account)
 *   CROSSTRADE_INSTRUMENT   optional override. Default: derived from the
 *                           GoCharting feed symbol — NQZ26 → MNQZ6 (the
 *                           contract is the NQ feed, the trade is MNQ).
 *                           Set "MNQ1!" to use the continuous front
 *                           month instead of the pinned contract.
 *   CROSSTRADE_REQUIRE_FLAT "flat" (default) refuses the entry unless the
 *                           account is flat on that instrument; set to
 *                           "" or "off" to allow stacking (NOT
 *                           recommended for the 1R cards).
 *   CROSSTRADE_REST         default ON — place with ABSOLUTE stop/target
 *                           at the signal's structural levels via
 *                           /orders/place; "0" returns to the
 *                           quote-anchored webhook.
 *   CROSSTRADE_SCALEOUT_REST default ON — the scale-out pair also goes
 *                           through the REST absolute-bracket path; "0"
 *                           (or CROSSTRADE_REST=0) returns the pair to
 *                           the quote-anchored webhook.
 * ------------------------------------------------------------------ */

import type { OrderIntent } from "./executor";
import { crossGuardGate } from "./crossGuard";
import { sendTelegram } from "./notify";
import { getLive } from "./live";
import { logExec } from "./execLog";
import { tradingHalted } from "./tradingHalt";
import { noteOrderSubmit, noteOrderAck, markOrderPhase } from "./execLatency";
import { buildFlattenWebhookPayload, buildCancelAllWebhookPayload } from "./flattenArm";
import { ctPositions } from "./ctAccount";

export type CrossTradeConfig = {
  url: string;
  key: string;
  account: string;
  instrument?: string;
  requireFlat: boolean;
};

export type CrossTradePayload = {
  key: string;
  command: "place";
  account: string;
  instrument: string;
  action: "buy" | "sell";
  qty: number;
  order_type: "market";
  tif: "day";
  destination: "tradovate";
  stop_loss: string;
  take_profit?: string; // omitted on runner legs — no fixed target
  order_id?: string; // ours, so a later CHANGE can address this order (7-day window)
  require_market_position?: string;
};

/** CHANGE command payload — the stop-loss update path. On Tradovate it can
 *  modify stop_price, qty, order_type, tif, expire_time, max_show and
 *  trail_offset; CrossTrade restores every field Tradovate requires on a
 *  partial modify from the live order version. */
export type CrossTradeChange = {
  key: string;
  command: "change";
  account: string;
  destination: "tradovate";
  order_id: string;
  stop_price?: string; // absolute price, US decimal format
  qty?: number;
  trail_offset?: string; // trailing distance in ticks (Tradovate path)
};

/** MNQ tick size in points (index) — the feed prices are index points. */
export const MNQ_TICK = 0.25;

const INSTRUMENT_RE = /^MNQ[FGHJKMNQUVXZ]\d$/;

/**
 * Map the GoCharting feed symbol to a Tradovate instrument name.
 * "NQZ26" (NQ feed, Dec 2026) → "MNQZ6" (the micro contract we trade).
 * Tradovate uses a one-digit year suffix. Values that are already
 * Tradovate-shaped (MNQZ6) or continuous (MNQ1!) pass through.
 * Returns null when the symbol can't be mapped — the caller must not
 * send an order for an unmappable instrument.
 */
export function mapInstrument(symbol: string, override?: string): string | null {
  if (override && override.trim()) return override.trim();
  const s = symbol.trim();
  if (INSTRUMENT_RE.test(s) || s === "MNQ1!") return s;
  const m = s.match(/^NQ([FGHJKMNQUVXZ])(\d{2})$/);
  if (!m) return null;
  return `MNQ${m[1]}${m[2].slice(-1)}`;
}

function ticksFromPoints(points: number): number {
  return Math.max(1, Math.round(points / MNQ_TICK));
}

/**
 * Build the flat JSON webhook payload for a bracketed market entry.
 * Throws on inputs that would produce an invalid order instead of
 * guessing; the quantity is capped by maxContracts() (MAX_MICRO_CONTRACTS
 * env knob, default 30 — the executor-level slippage×size bound).
 *
 * opts.orderId attaches our order id (required to CHANGE the stop later);
 * opts.withTarget=false omits take_profit — the runner leg of a scale-out
 * has an open target and only its stop is managed.
 */
export function buildCrossTradePayload(
  intent: OrderIntent,
  cfg: CrossTradeConfig,
  opts: { orderId?: string; withTarget?: boolean } = {},
): CrossTradePayload {
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    throw new Error(`crossTrade: cannot map symbol "${intent.symbol}" to a Tradovate instrument`);
  }
  const qty = Math.max(1, Math.min(maxContracts(), Math.floor(intent.contracts)));
  const stopTicks = ticksFromPoints(Math.abs(intent.entry - intent.stop));
  if (!Number.isFinite(stopTicks) || stopTicks < 1) {
    throw new Error(`crossTrade: invalid stop — entry ${intent.entry} stop ${intent.stop}`);
  }
  const payload: CrossTradePayload = {
    key: cfg.key,
    command: "place",
    account: cfg.account,
    instrument,
    action: intent.dir === "long" ? "buy" : "sell",
    qty,
    order_type: "market",
    tif: "day",
    destination: "tradovate",
    stop_loss: `${stopTicks} ticks`,
  };
  if (opts.withTarget ?? true) {
    const targetTicks = ticksFromPoints(Math.abs(intent.target - intent.entry));
    if (!Number.isFinite(targetTicks) || targetTicks < 1) {
      throw new Error(`crossTrade: invalid target — entry ${intent.entry} target ${intent.target}`);
    }
    payload.take_profit = `${targetTicks} ticks`;
  }
  if (opts.orderId) payload.order_id = opts.orderId;
  if (cfg.requireFlat) payload.require_market_position = "flat";
  return payload;
}

/** Build the CHANGE payload that moves an already-placed order's stop.
 *  Pure + unit-testable; price values are absolute US decimals. */
export function buildChangePayload(
  cfg: CrossTradeConfig,
  change: { orderId: string; stopPrice?: number; qty?: number; trailOffsetTicks?: number },
): CrossTradeChange {
  if (!change.stopPrice && !change.qty && !change.trailOffsetTicks) {
    throw new Error("crossTrade: CHANGE needs at least one of stopPrice, qty, trailOffsetTicks");
  }
  const payload: CrossTradeChange = {
    key: cfg.key,
    command: "change",
    account: cfg.account,
    destination: "tradovate",
    order_id: change.orderId,
  };
  if (change.stopPrice !== undefined) {
    if (!Number.isFinite(change.stopPrice)) throw new Error("crossTrade: CHANGE stop_price is not finite");
    payload.stop_price = change.stopPrice.toFixed(2);
  }
  if (change.qty !== undefined) payload.qty = change.qty;
  if (change.trailOffsetTicks !== undefined) payload.trail_offset = `${Math.max(1, Math.round(change.trailOffsetTicks))} ticks`;
  return payload;
}

/**
 * Split one intent into the scale-out's two legs: the bank leg (2/3 of the
 * contracts, fixed 1R target from the intent) and the runner leg (the rest,
 * open target — only its stop is managed). Pure; floors at 1 contract.
 */
export function splitScaleOut(intent: OrderIntent): { bank: OrderIntent; runner: OrderIntent } {
  const total = Math.max(1, Math.floor(intent.contracts));
  const bankQty = Math.max(1, Math.floor((total * 2) / 3));
  const runnerQty = Math.max(0, total - bankQty);
  return {
    bank: { ...intent, contracts: bankQty },
    runner: { ...intent, contracts: runnerQty }, // 0 → single-leg order only
  };
}

export function crossTradeEnabled(): boolean {
  return !!(
    process.env.CROSSTRADE_URL &&
    process.env.CROSSTRADE_KEY &&
    process.env.CROSSTRADE_ACCOUNT
  );
}

function loadConfig(): CrossTradeConfig {
  const requireFlatRaw = process.env.CROSSTRADE_REQUIRE_FLAT ?? "flat";
  const requireFlat = !/^(0|false|no|off|)$/i.test(requireFlatRaw.trim());
  return {
    url: (process.env.CROSSTRADE_URL ?? "").trim(),
    key: (process.env.CROSSTRADE_KEY ?? "").trim(),
    account: (process.env.CROSSTRADE_ACCOUNT ?? "").trim(),
    instrument: process.env.CROSSTRADE_INSTRUMENT,
    requireFlat,
  };
}

function describeIntent(intent: OrderIntent): string {
  return (
    `[crossTrade] ${intent.dir.toUpperCase()} ${intent.contracts} ${intent.symbol} ` +
    `entry ${intent.entry.toFixed(2)} · stop ${intent.stop.toFixed(2)} · target ${intent.target.toFixed(2)} · ${intent.timeET} NY`
  );
}

/**
 * Classify a webhook response. CrossTrade returns HTTP 200 for BOTH
 * accepted orders and rejected payloads — rejections carry
 * {"error": "..."} in the body (verified against the live endpoint),
 * so the body decides, not the status alone. Pure, unit-testable.
 */
export function classifyResponse(status: number, bodyText: string): { ok: boolean; reason: string } {
  const body = bodyText.trim().slice(0, 400);
  if (!Number.isFinite(status)) {
    return { ok: false, reason: "no HTTP status" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `rejected (${status}) ${body}`.trim() };
  }
  let j: unknown = null;
  try {
    j = JSON.parse(body);
  } catch {
    /* plain-text ack */
  }
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const err = (j as Record<string, unknown>).error;
    if (typeof err === "string" && err.length) {
      return { ok: false, reason: `rejected (${status}) ${err}` };
    }
  }
  markEntryPlaced();
  return { ok: true, reason: `accepted (${status})${body ? ` ${body}` : ""}` };
}

/**
 * Send the order intent to the CrossTrade webhook. Dry-run (log only)
 * unless EXECUTE_LIVE=1.
 */
export async function placeCrossTradeOrder(
  intent: OrderIntent,
): Promise<{ ok: boolean; reason: string }> {
  const guard = await crossGuardGate();
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  if (!live) {
    console.log(`[crossTrade] DRY-RUN ${describeIntent(intent)}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  if (tradingHalted()) return { ok: false, reason: "trading halted by owner — dashboard kill switch (resume from the dashboard)" };


  let payload: CrossTradePayload;
  try {
    payload = buildCrossTradePayload(intent, cfg);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

  console.log(`[crossTrade] LIVE ${describeIntent(intent)} → ${payload.instrument} @ ${cfg.account}`);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const cls = classifyResponse(res.status, await res.text());
    // the webhook path carries no OSO child ids for the late-rejection
    // check, but the bracket still registers so the 30s watchdog can
    // verify and repair it — same global invariant as the REST path
    if (cls.ok) registerOpenProtection(intent, { rearmOk: true });
    return cls;
  } catch (e) {
    // A timeout does NOT establish whether the order was placed (docs) —
    // report UNKNOWN and require Alert History verification, never retry.
    return {
      ok: false,
      reason: `UNKNOWN (network: ${String(e)}) — check CrossTrade Alert History before acting; no automatic retry`,
    };
  }
}

/** Send a CHANGE (stop update) for an order we placed with our own order_id.
 *  Same dry-run gate and no-retry/UNKNOWN semantics as placement. */
export async function changeCrossTradeOrder(
  change: { orderId: string; stopPrice?: number; qty?: number; trailOffsetTicks?: number },
): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const what = `order ${change.orderId} → stop ${change.stopPrice?.toFixed(2) ?? "—"} qty ${change.qty ?? "—"} trail ${change.trailOffsetTicks ?? "—"}`;
  if (!live) {
    console.log(`[crossTrade] DRY-RUN CHANGE ${what}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  let payload: CrossTradeChange;
  try {
    payload = buildChangePayload(cfg, change);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  console.log(`[crossTrade] LIVE CHANGE ${what} @ ${cfg.account}`);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return classifyResponse(res.status, await res.text());
  } catch (e) {
    return {
      ok: false,
      reason: `UNKNOWN (network: ${String(e)}) — check CrossTrade Alert History before acting; no automatic retry`,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Flatten arm I/O (FLATTEN_AT_PROFIT / FLATTEN_AT_LOSS — both default
 * OFF; lib/flattenArm.ts holds the pure decision, the guard holds the
 * once-per-day latch). When the guard returns the "flatten" verdict,
 * crossGuard calls flattenArmFire: cancel-all + FLATTEN through the
 * webhook (or the REST flatten per FLATTEN_MODE), verify the account is
 * flat after FLATTEN_VERIFY_S, retry once via REST, then the manual
 * alert. A PROTECTIVE exit: it fires even when the trading kill switch
 * is on (the switch stops ENTRIES, never protective exits).
 * ------------------------------------------------------------------ */

/** POST one webhook payload (cancel-all / flatten). Same no-retry/UNKNOWN
 *  semantics as placement: a timeout does NOT establish whether the
 *  command was processed. */
async function postFlattenWebhook(payload: Record<string, unknown>): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return classifyResponse(res.status, await res.text());
  } catch (e) {
    return {
      ok: false,
      reason: `UNKNOWN (network: ${String(e)}) — check CrossTrade Alert History before acting; no automatic retry`,
    };
  }
}

/** Cancel every resting order, then FLATTEN the linked account at market.
 *  Dry-run (log only) unless EXECUTE_LIVE=1 — same gate as placement. */
export async function flattenViaWebhook(): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  if (process.env.EXECUTE_LIVE !== "1") {
    console.log(`[crossTrade] DRY-RUN flatten (cancelallorders + flatten) @ ${cfg.account}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  console.log(`[crossTrade] LIVE FLATTEN (cancelallorders + flatten) @ ${cfg.account}`);
  const cancel = await postFlattenWebhook(buildCancelAllWebhookPayload(cfg));
  const flat = await postFlattenWebhook(buildFlattenWebhookPayload(cfg));
  return { ok: cancel.ok && flat.ok, reason: `cancel-all: ${cancel.reason} · flatten: ${flat.reason}` };
}

/** is the linked account flat? (sum of net positions ≈ 0; unreadable =
 *  NOT flat — fail closed) */
async function accountIsFlat(): Promise<boolean> {
  const rows = await ctPositions();
  if (rows === null) return false;
  return rows.reduce((sum, r) => sum + Number(r.netPos ?? r.qty ?? 0), 0) === 0;
}

/** the flatten-arm ACTION. Called only when the guard returned the
 *  "flatten" verdict (the guard's once-per-day latch is the de-dupe);
 *  safe to call again — it verifies instead of re-firing. */
export async function flattenArmFire(reason: string): Promise<void> {
  const live = process.env.EXECUTE_LIVE === "1";
  const mode = (process.env.FLATTEN_MODE ?? "webhook").toLowerCase();
  const verifyS = Math.max(2, Number(process.env.FLATTEN_VERIFY_S) || 5);
  await logExec({ key: "flatten", label: "flatten_arm", attempt: "fire", outcome: live ? "flatten_fired" : "flatten_dry", reason });
  if (!live) {
    console.log(`[crossTrade] flatten arm DRY-RUN (${reason})`);
    return;
  }

  try {
    if (mode === "rest") {
      const r = await flattenCrossTradePositionREST();
      if (!r.ok) {
        await sendTelegram(`⚠️ flatten arm: REST flatten failed (${r.reason}) — verify manually. Day: ${reason}`);
        return;
      }
    } else if (mode === "both") {
      const w = await flattenViaWebhook();
      const r = await flattenCrossTradePositionREST();
      if (!w.ok || !r.ok) {
        await sendTelegram(`⚠️ flatten arm: flatten path failed (webhook ${w.reason} · rest ${r.reason}) — verify manually. Day: ${reason}`);
        return;
      }
    } else {
      const w = await flattenViaWebhook();
      if (!w.ok) {
        await sendTelegram(`⚠️ flatten arm: webhook flatten failed (${w.reason}) — verify manually. Day: ${reason}`);
        return;
      }
    }

    // verify flat after FLATTEN_VERIFY_S; one REST retry, then manual
    await new Promise((r) => setTimeout(r, verifyS * 1000));
    if (await accountIsFlat()) return;
    await logExec({ key: "flatten", label: "flatten_arm", attempt: "verify", outcome: "not_flat_retry", reason });
    const retry = await flattenCrossTradePositionREST();
    if (retry.ok) {
      await new Promise((r) => setTimeout(r, verifyS * 1000));
      if (await accountIsFlat()) return;
    }
    await sendTelegram(`🚨🚨 FLATTEN ARM: account still NOT flat after retry — <b>close manually NOW</b> — ${reason}`);
  } catch (e) {
    await sendTelegram(`🚨 flatten arm error: ${String(e)} — verify the account manually. Day: ${reason}`);
  }
}

/**
 * Place the scale-out pair: bank leg (2/3, fixed 1R target) + runner leg
 * (1/3, open target, stop managed later via CHANGE). Both carry our own
 * order_id (`<id>-bank` / `<id>-run`). Returns the ids so the caller can
 * register the runner with the ladder tracker.
 */
export async function placeCrossTradeScaleOut(
  intent: OrderIntent,
): Promise<{ ok: boolean; reason: string; bankOrderId?: string; runnerOrderId?: string; runnerQty?: number }> {
  const guard = await crossGuardGate();
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const { bank, runner } = splitScaleOut(intent);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const bankOrderId = `${id}-bank`;
  const runnerOrderId = `${id}-run`;

  if (runner.contracts < 1) {
    // too small to split — fall back to a single bracketed order
    return placeCrossTradeOrder(bank);
  }
  if (live && tradingHalted()) return { ok: false, reason: "trading halted by owner — dashboard kill switch (resume from the dashboard)" };
  if (!live) {
    console.log(
      `[crossTrade] DRY-RUN SCALE-OUT ${intent.dir.toUpperCase()} ${intent.contracts} ${intent.symbol} ` +
        `→ bank ${bank.contracts} (1R) + runner ${runner.contracts} (ladder) · ${intent.timeET} NY`,
    );
    return { ok: true, reason: "dry-run (logged only)", bankOrderId, runnerOrderId, runnerQty: runner.contracts };
  }

  let bankPayload: CrossTradePayload;
  let runnerPayload: CrossTradePayload;
  try {
    bankPayload = buildCrossTradePayload(bank, cfg, { orderId: bankOrderId, withTarget: true });
    runnerPayload = buildCrossTradePayload(runner, cfg, { orderId: runnerOrderId, withTarget: false });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

  const post = async (label: string, payload: CrossTradePayload) => {
    console.log(`[crossTrade] LIVE SCALE-OUT ${label} → ${payload.instrument} @ ${cfg.account}`);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      return classifyResponse(res.status, await res.text());
    } catch (e) {
      return {
        ok: false,
        reason: `UNKNOWN (network: ${String(e)}) — check CrossTrade Alert History before acting; no automatic retry`,
      };
    }
  };

  const bankRes = await post(`bank ${bankOrderId}`, bankPayload);
  const runnerRes = await post(`runner ${runnerOrderId}`, runnerPayload);
  const ok = bankRes.ok && runnerRes.ok;
  if (ok) {
    markEntryPlaced();
    // webhook scale-out: no OSO child ids for the late-rejection check,
    // but the bracket registers so the watchdog can verify/repair
    // (flatten-only — the ladder owns the runner stop)
    registerOpenProtection(intent, { rearmOk: false });
  }
  return {
    ok,
    reason: `bank: ${bankRes.reason} · runner: ${runnerRes.reason}`,
    bankOrderId: bankRes.ok ? bankOrderId : undefined,
    runnerOrderId: runnerRes.ok ? runnerOrderId : undefined,
    runnerQty: runner.contracts,
  };
}

/* ------------------------------------------------------------------ *
 * REST absolute-bracket path — CROSSTRADE_REST=1 switches the executor
 * to it. Fixes the webhook's quote-anchored brackets: the stop AND
 * target are sent as ABSOLUTE prices at the signal's structural levels
 * (the trade-review finding that quote-anchored stops cost ~$250-300).
 *
 * Flat check: the webhook's require_market_position=flat has no REST
 * equivalent, so we refuse client-side when the account holds an MNQ
 * position (read via the positions endpoint; fail closed on an
 * unreadable reply). Exactly-once semantics match the webhook path:
 * no automatic retry on ambiguous replies.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Flat-entry latch — a hard temporal barrier against stacked entries.
 * After OUR entry, a new entry is refused outright for 60s (no read can
 * be trusted that fast — the 14:21 stack came from a stale CrossTrade
 * read that showed "flat" while a position was open), and afterwards a
 * fresh positions read must CONFIRM flat before the latch clears.
 * ------------------------------------------------------------------ */

let entryPlacedAt = 0;
let awaitingFlat = false;

export function markEntryPlaced() {
  entryPlacedAt = Date.now();
  awaitingFlat = true;
}

export type StackDecision = "allow" | "refuse_recent_entry" | "refuse_position_open" | "confirm_flat";

/** crossed-stop dispatch gate (2026-10-08 naked-position incident).
 *  Tradovate validates the OSO stop leg against the CURRENT market at
 *  placement: a stop on the marketable side is rejected with
 *  InvalidPrice a split second after the place is accepted, and the
 *  entry still fills — naked. A long's sell-stop must sit BELOW the
 *  tape, a short's buy-stop ABOVE it. Returns null (unknown → allow)
 *  when the tape price is unavailable. Pure + unit-tested. */
export function stopCrossedAtDispatch(
  dir: "long" | "short",
  stop: number,
  ltp: number | null | undefined,
): boolean | null {
  if (ltp === null || ltp === undefined || !Number.isFinite(ltp) || !Number.isFinite(stop)) return null;
  return dir === "long" ? ltp <= stop : ltp >= stop;
}

/** crossed-limit dispatch gate (2026-10-08 −$1,056 stop-slippage
 *  incident). A resting limit that the tape has already moved THROUGH at
 *  dispatch is marketable: it fills instantly at the market, the fill
 *  drifts past the signal, and the signal-anchored stop compresses
 *  (the 12:16 card's 3.2-pt stop became a 0.8-pt stop after a 2.4-pt
 *  drift — instant stop-out, 134 ticks of slippage). thresholdPts lets
 *  sub-tick crossings (the clean 10:10/11:31 fills) through. Null =
 *  unknown tape → allow. Pure + unit-tested. */
export function limitCrossedAtDispatch(
  dir: "long" | "short",
  limit: number,
  ltp: number | null | undefined,
  thresholdPts = 1,
): boolean | null {
  if (ltp === null || ltp === undefined || !Number.isFinite(ltp) || !Number.isFinite(limit)) return null;
  const thr = Math.max(0, thresholdPts);
  return dir === "long" ? ltp < limit - thr : ltp > limit + thr;
}

/** re-anchor a bracket to the actual FILL when the fill drifted past the
 *  signal and compressed the stop distance (the planned risk must be the
 *  risk you get). Returns the fill-anchored stop/target, or null when
 *  the bracket is healthy (drift < half the stop distance). Pure +
 *  unit-tested. */
export function reanchorBracketForFill(
  intent: OrderIntent,
  fill: number,
  minCompressionFactor = 0.5,
): { stop: number; target: number } | null {
  if (!Number.isFinite(fill)) return null;
  const riskDist = Math.abs(intent.entry - intent.stop);
  const targetDist = Math.abs(intent.target - intent.entry);
  if (!(riskDist > 0)) return null;
  const dirSign = intent.dir === "long" ? 1 : -1;
  const actualStopDist = (fill - intent.stop) * dirSign; // > 0 when the stop is on the valid side
  if (actualStopDist >= riskDist * minCompressionFactor) return null;
  return {
    stop: fill - dirSign * riskDist,
    target: fill + dirSign * targetDist,
  };
}

/** executor-level micro-contract cap — bounds slippage × size so a
 *  gap-through stop fill cannot cost 10× the planned risk. Default 30
 *  (the current behavior); the study picks the live value. */
export function maxContracts(): number {
  const n = Number(process.env.MAX_MICRO_CONTRACTS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

/** pure latch decision (unit-tested): elapsed = ms since our entry,
 *  held = MNQ contracts held per the fresh read (null = read failed). */
export function stackGuardDecision(
  awaiting: boolean,
  elapsedMs: number,
  held: number | null,
  minConfirmMs = 60_000,
): StackDecision {
  if (!awaiting) return held ? "refuse_position_open" : "allow";
  if (elapsedMs < minConfirmMs) return "refuse_recent_entry";
  if (held === null) return "refuse_recent_entry"; // unreadable book — keep refusing
  if (held > 0) return "refuse_position_open";
  return "confirm_flat";
}

/** place a bracketed entry with ABSOLUTE stop/target prices. Default is a
 *  market entry; opts.limitPrice switches to a resting LIMIT at that price
 *  (with our own orderId so a later cancel can address it — the CrossTrade
 *  cancel route accepts the user-assigned orderId). opts.label feeds the
 *  protection alerts. GLOBAL safety invariants live here (every REST
 *  placement passes through): the crossed-stop dispatch gate for limits,
 *  protection registration, and the post-place bracket-leg verification. */
export async function placeCrossTradeOrderREST(
  intent: OrderIntent,
  opts: { limitPrice?: number; label?: string } = {},
): Promise<{
  ok: boolean;
  reason: string;
  orderId?: string;
  nativeEntryId?: string | number;
  stopChildId?: string | number;
  targetChildId?: string | number;
}> {
  const g0 = performance.now();
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const orderId = opts.limitPrice !== undefined ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-lmt` : undefined;
  if (live && tradingHalted()) return { ok: false, reason: "trading halted by owner — dashboard kill switch (resume from the dashboard)" };
  if (!live) {
    console.log(
      `[crossTrade] DRY-RUN(REST) ${opts.limitPrice !== undefined ? "LIMIT" : ""} ${describeIntent(intent)}` +
        (opts.limitPrice !== undefined ? ` @ ${opts.limitPrice.toFixed(2)}` : ""),
    );
    return { ok: true, reason: "dry-run (logged only)", orderId };
  }

  // crossed-stop dispatch gate (GLOBAL, 2026-10-08 incident): a resting
  // limit whose OSO stop sits on the marketable side of the current tape
  // is rejected by Tradovate at placement (InvalidPrice) and the entry
  // then fills naked — refuse at the choke point so no caller can place
  // one. Feeds keep their own quiet skips for the journal.
  if (opts.limitPrice !== undefined) {
    const ltp = currentTapeLtp();
    if (stopCrossedAtDispatch(intent.dir, intent.stop, ltp) === true) {
      return {
        ok: false,
        reason: `crossed-stop gate — tape ${Number(ltp).toFixed(2)} past stop ${intent.stop.toFixed(2)} at dispatch (the OSO stop would be rejected and the limit would fill naked)`,
      };
    }
    // crossed-limit dispatch gate (GLOBAL, 2026-10-08 −$1,056 slippage
    // incident): a limit the tape has already moved through fills at the
    // market and the signal-anchored stop compresses — the planned risk
    // is never the actual risk. Refuse; the entry premise is gone.
    if (limitCrossedAtDispatch(intent.dir, opts.limitPrice, ltp) === true) {
      return {
        ok: false,
        reason: `crossed-limit gate — tape ${Number(ltp).toFixed(2)} through limit ${opts.limitPrice.toFixed(2)} at dispatch (the fill would drift and compress the stop)`,
      };
    }
  }

  // broker price agreement — the tape can lag the real market (2026-10-04:
  // tape 31141 vs broker 31155 → market fill above the take-profit → instant
  // OCO close). No real-time quote source exists for a Tradovate account
  // (CrossTrade market data is NT8-only), so this is enforced by the
  // broker resting-limit entries — the retrace path's DEFAULT
  // (signalFeed.retraceUseLimit; CROSSTRADE_LIMIT_ENTRIES=0 opts out) —
  // and the watcher's fill verification instead of a pre-trade quote check.

  // PRE-FLIGHT PARALLELIZATION (2026-10-12): the account guard
  // (snapshot REST + guard-state DB hydration) and the flat gate
  // (positions REST) are independent read-only pre-checks — they used to
  // run serially, adding two full round trips between detection and the
  // order POST. They now run concurrently; the POST stays strictly last,
  // and every verdict stays fail-closed exactly as before (either check
  // failing refuses the placement).
  let guardMs = 0;
  let flatMs = 0;
  const guardP = crossGuardGate().then((v) => {
    guardMs = performance.now() - g0;
    return v;
  });
  const fT0 = performance.now();
  const flatP = restFlatGate(cfg).then((v) => {
    flatMs = performance.now() - fT0;
    return v;
  });
  const [guard, flat] = await Promise.all([guardP, flatP]);
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };

  // telemetry: open the submit→fill leg before the remaining gates so the
  // flat-gate phase can attach (lib/execLatency.ts)
  const fillId = noteOrderSubmit(opts.label ?? describeIntent(intent), intent.dir, intent.contracts, { guardMs });
  markOrderPhase(fillId, "flat", flatMs);
  if (!flat.ok) return { ok: false, reason: flat.reason };

  let payload: RESTPlacePayload;
  try {
    payload = buildRESTPlacePayload(intent, cfg, { orderId, limitPrice: opts.limitPrice });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

  console.log(
    `[crossTrade] LIVE(REST) ${payload.orderType === "limit" ? "LIMIT" : ""} ${intent.dir.toUpperCase()} ${payload.qty} ${payload.instrument} ` +
      `entry ${intent.entry.toFixed(2)} · stop ${intent.stop.toFixed(2)} · target ${intent.target.toFixed(2)} · ${intent.timeET} NY`,
  );
  const submitT0 = performance.now();
  const leg = await postRESTLeg(payload, cfg);
  markOrderPhase(fillId, "post", performance.now() - submitT0);
  noteOrderAck(fillId, performance.now() - submitT0, performance.now() - submitT0);
  if (leg.kind === "auth") {
    // plan/auth rejections happen BEFORE dispatch — safe to fall back to
    // the webhook path exactly once (nothing was placed)
    console.warn(`[crossTrade] REST unavailable (${leg.reason}) — falling back to the webhook path`);
    return placeCrossTradeOrder(intent);
  }
  if (leg.kind !== "ok") return { ok: false, reason: leg.reason };
  markEntryPlaced();
  const label = opts.label ?? describeIntent(intent);
  registerOpenProtection(intent, { rearmOk: true });
  verifyBracketsAfterPlace({
    label,
    key: `protect|${Date.now()}`,
    intent,
    entryOrderId: orderId,
    nativeEntryId: leg.children?.nativeEntryId,
    stopChildId: leg.children?.stopChildId,
    targetChildId: leg.children?.targetChildId,
  });
  return {
    ok: true,
    reason: `REST placed ${payload.orderId ?? ""}`,
    orderId,
    nativeEntryId: leg.children?.nativeEntryId,
    stopChildId: leg.children?.stopChildId,
    targetChildId: leg.children?.targetChildId,
  };
}

/* ------------------------------------------------------------------ *
 * REST payload shape — the /orders/place body with ABSOLUTE prices.
 * Pure + unit-tested; stopLoss is the signal's structural stop, not a
 * tick distance from whatever quote the webhook happens to see.
 * ------------------------------------------------------------------ */

export type RESTPlacePayload = {
  instrument: string;
  action: "buy" | "sell";
  qty: number;
  orderType: "market" | "limit";
  tif: "day";
  limitPrice?: number; // the resting limit price (limit entries only)
  stopLoss: string; // ABSOLUTE — the signal's structural stop
  takeProfit?: string; // ABSOLUTE — omitted on runner legs (no fixed target)
  orderId?: string; // ours, so a later cancel/CHANGE can address this order
};

export function buildRESTPlacePayload(
  intent: OrderIntent,
  cfg: CrossTradeConfig,
  opts: { orderId?: string; withTarget?: boolean; limitPrice?: number } = {},
): RESTPlacePayload {
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    throw new Error(`crossTrade: cannot map symbol "${intent.symbol}" to a Tradovate instrument`);
  }
  if (!Number.isFinite(intent.stop)) {
    throw new Error(`crossTrade: invalid stop — entry ${intent.entry} stop ${intent.stop}`);
  }
  if (opts.limitPrice !== undefined && !Number.isFinite(opts.limitPrice)) {
    throw new Error(`crossTrade: invalid limit price — ${opts.limitPrice}`);
  }
  const qty = Math.max(1, Math.min(maxContracts(), Math.floor(intent.contracts)));
  const isLimit = opts.limitPrice !== undefined;
  const payload: RESTPlacePayload = {
    instrument,
    action: intent.dir === "long" ? "buy" : "sell",
    qty,
    orderType: isLimit ? "limit" : "market",
    tif: "day",
    stopLoss: intent.stop.toFixed(2),
  };
  if (isLimit) payload.limitPrice = opts.limitPrice;
  if (opts.withTarget ?? true) {
    if (!Number.isFinite(intent.target)) {
      throw new Error(`crossTrade: invalid target — entry ${intent.entry} target ${intent.target}`);
    }
    payload.takeProfit = intent.target.toFixed(2);
  }
  if (opts.orderId) payload.orderId = opts.orderId;
  return payload;
}

type RESTLegResult = {
  kind: "ok" | "auth" | "rejected" | "unknown";
  reason: string;
  /** Tradovate native ids from the dispatcher envelope: the entry and the
   *  OSO children. Mapped by what WE sent (take-profit first, then stop —
   *  the envelope's oso1Id/oso2Id order) so a single-leg (stop-only)
   *  placement maps oso1 to the stop. */
  children?: { nativeEntryId?: string | number; stopChildId?: string | number; targetChildId?: string | number };
};

/** POST one REST leg. 401/403 = auth (pre-dispatch, safe to fall back);
 *  non-2xx or success:false = rejection (pre-dispatch, nothing placed);
 *  network failure = UNKNOWN (do NOT retry — reconcile first). */
async function postRESTLeg(payload: Omit<RESTPlacePayload, "stopLoss"> & { stopLoss?: string }, cfg: CrossTradeConfig): Promise<RESTLegResult> {
  try {
    const res = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/orders/place`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const bodyText = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { kind: "auth", reason: `REST unavailable (${res.status})` };
    }
    let j: Record<string, unknown> | null = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      /* plain text */
    }
    if (!res.ok) return { kind: "rejected", reason: `REST rejected (${res.status}) ${bodyText.slice(0, 200)}` };
    if (j && j.success === false) {
      return { kind: "rejected", reason: `REST rejected: ${String(j.error ?? bodyText).slice(0, 200)}` };
    }
    // capture the OSO child ids — the late-rejection verifier addresses the
    // stop leg with them (an accepted place can still be rejected ~10ms later
    // by Tradovate's risk layer, e.g. InvalidPrice on a crossed stop).
    const resp = (j?.response ?? null) as Record<string, unknown> | null;
    const o1 = resp?.oso1Id !== undefined && resp?.oso1Id !== null ? (resp.oso1Id as string | number) : undefined;
    const o2 = resp?.oso2Id !== undefined && resp?.oso2Id !== null ? (resp.oso2Id as string | number) : undefined;
    const children: RESTLegResult["children"] = resp ? { nativeEntryId: (resp.orderId as string | number | undefined) ?? undefined } : undefined;
    if (children) {
      if (payload.takeProfit !== undefined && payload.stopLoss !== undefined) {
        children.targetChildId = o1;
        children.stopChildId = o2;
      } else if (payload.stopLoss !== undefined) {
        children.stopChildId = o1; // stop-only placement (runner leg)
      }
    }
    return { kind: "ok", reason: bodyText.slice(0, 120), children };
  } catch (e) {
    return {
      kind: "unknown",
      reason: `REST UNKNOWN (network: ${String(e)}) — reconcile before acting; no automatic retry`,
    };
  }
}

/** the flat check + entry latch shared by the REST paths (single-leg and
 *  scale-out). One gate per TRADE — the scale-out runner must NOT be
 *  flat-checked separately or a filled bank would refuse its own runner. */
async function restFlatGate(cfg: CrossTradeConfig): Promise<{ ok: boolean; reason: string }> {
  const latchNow = Date.now();
  const elapsed = latchNow - entryPlacedAt;
  // Hard 60s barrier: inside the window no read is trusted (stale reads lie —
  // that is exactly how the 14:21 stack happened). After the window the
  // latch must be cleared by a FRESH positions read confirming flat — so
  // never short-circuit on the latch itself past 60s; always read the book.
  if (awaitingFlat && elapsed < 60_000) {
    return {
      ok: false,
      reason: `crossTrade: entry placed ${Math.round(elapsed / 1000)}s ago — refusing to stack inside the 60s confirm window`,
    };
  }
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/positions`, {
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> | Array<{ data?: Array<Record<string, unknown>> }> };
    if (!j.success) return { ok: false, reason: `crossTrade: flat check failed — ${JSON.stringify(j).slice(0, 160)}` };
    const flat: unknown[] = [];
    for (const row of (j.data ?? []) as Array<Record<string, unknown>>) {
      const inner = Array.isArray(row.data) ? (row.data as Array<Record<string, unknown>>) : [row];
      flat.push(...inner);
    }
    const heldCount = flat.filter((p) => {
      const r = p as Record<string, unknown>;
      const qty = Number(r.netPos ?? r.qty ?? 0);
      const ins = String(r.instrument ?? r.contractName ?? "");
      return qty !== 0 && ins.includes("MNQ");
    }).length;
    const decision = stackGuardDecision(awaitingFlat, elapsed, heldCount);
    if (decision === "refuse_position_open") {
      return { ok: false, reason: "crossTrade: not flat — an MNQ position is open (refusing)" };
    }
    if (decision === "refuse_recent_entry") {
      return { ok: false, reason: `crossTrade: our entry is ${Math.round(elapsed / 1000)}s old and the book is unreadable — refusing to stack` };
    }
    if (decision === "confirm_flat") awaitingFlat = false; // confirmed by a successful read
    return { ok: true, reason: "flat confirmed" };
  } catch (e) {
    return { ok: false, reason: `crossTrade: cannot verify flat state (${String(e)}) — refusing` };
  }
}

/* ------------------------------------------------------------------ *
 * REST scale-out — the bank+runner pair with ABSOLUTE brackets, the
 * same fix the single-leg path got: stopLoss/takeProfit at the
 * signal's structural levels, never quote-anchored ticks.
 *
 * Fallback semantics (per leg, pre-dispatch only):
 *   bank 401/403 → NOTHING was placed → the whole pair falls back to
 *     the webhook scale-out exactly once.
 *   bank placed, runner 401/403 → the runner alone falls back to the
 *     webhook (the bank is never re-placed).
 *   UNKNOWN (network) → never retried, reported for reconciliation.
 * ------------------------------------------------------------------ */

export async function placeCrossTradeScaleOutREST(
  intent: OrderIntent,
): Promise<{ ok: boolean; reason: string; bankOrderId?: string; runnerOrderId?: string; runnerQty?: number }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const { bank, runner } = splitScaleOut(intent);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const bankOrderId = `${id}-bank`;
  const runnerOrderId = `${id}-run`;

  if (runner.contracts < 1) {
    // too small to split — fall back to a single bracketed order (REST path)
    return placeCrossTradeOrderREST(bank);
  }
  if (live && tradingHalted()) return { ok: false, reason: "trading halted by owner — dashboard kill switch (resume from the dashboard)" };
  if (!live) {
    console.log(
      `[crossTrade] DRY-RUN(REST) SCALE-OUT ${intent.dir.toUpperCase()} ${intent.contracts} ${intent.symbol} ` +
        `→ bank ${bank.contracts} (1R) + runner ${runner.contracts} (ladder) · ${intent.timeET} NY`,
    );
    return { ok: true, reason: "dry-run (logged only)", bankOrderId, runnerOrderId, runnerQty: runner.contracts };
  }

  // pre-flight parallelization (same as the single-leg path): guard ‖ flat
  const [guard, flat] = await Promise.all([crossGuardGate(), restFlatGate(cfg)]);
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
  if (!flat.ok) return { ok: false, reason: flat.reason };

  let bankPayload: RESTPlacePayload;
  let runnerPayload: RESTPlacePayload;
  try {
    bankPayload = buildRESTPlacePayload(bank, cfg, { orderId: bankOrderId, withTarget: true });
    runnerPayload = buildRESTPlacePayload(runner, cfg, { orderId: runnerOrderId, withTarget: false });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }

  console.log(`[crossTrade] LIVE(REST) SCALE-OUT bank ${bankOrderId} → ${bankPayload.instrument} @ ${cfg.account}`);
  const bankRes = await postRESTLeg(bankPayload, cfg);
  if (bankRes.kind === "auth") {
    console.warn(`[crossTrade] REST unavailable for the pair (${bankRes.reason}) — falling back to the webhook scale-out`);
    return placeCrossTradeScaleOut(intent);
  }
  if (bankRes.kind !== "ok") return { ok: false, reason: `bank: ${bankRes.reason}` };
  markEntryPlaced(); // the entry is placed — latch against stacking from here

  console.log(`[crossTrade] LIVE(REST) SCALE-OUT runner ${runnerOrderId} → ${runnerPayload.instrument} @ ${cfg.account}`);
  const runnerRes = await postRESTLeg(runnerPayload, cfg);
  if (runnerRes.kind === "auth") {
    // bank already placed — fall back to the webhook for the RUNNER ONLY.
    // (The runner webhook still requires flat; if the bank already filled
    // it will be refused and reported — never silently stacked.)
    console.warn(`[crossTrade] REST unavailable for the runner (${runnerRes.reason}) — runner via webhook (bank already placed)`);
    const w = await postWebhookLeg(runner, cfg, { orderId: runnerOrderId, withTarget: false });
    if (w.ok) registerOpenProtection(intent, { rearmOk: false });
    return {
      ok: w.ok,
      reason: `bank: ${bankRes.reason} · runner(webhook): ${w.reason}`,
      bankOrderId,
      runnerOrderId: w.ok ? runnerOrderId : undefined,
      runnerQty: runner.contracts,
    };
  }
  if (bankRes.kind === "ok" && runnerRes.kind === "ok") {
    // global protection: the ladder owns the runner stop — repair may only
    // flatten — and each leg's OSO children are verified after placement
    registerOpenProtection(intent, { rearmOk: false });
    verifyBracketsAfterPlace({
      label: `${describeIntent(bank)} (bank)`,
      key: `protect|${Date.now()}`,
      intent: bank,
      entryOrderId: bankOrderId,
      nativeEntryId: bankRes.children?.nativeEntryId,
      stopChildId: bankRes.children?.stopChildId,
      targetChildId: bankRes.children?.targetChildId,
    });
    verifyBracketsAfterPlace({
      label: `${describeIntent(runner)} (runner)`,
      key: `protect|${Date.now()}`,
      intent: runner,
      entryOrderId: runnerOrderId,
      nativeEntryId: runnerRes.children?.nativeEntryId,
      stopChildId: runnerRes.children?.stopChildId,
      targetChildId: runnerRes.children?.targetChildId,
    });
  }
  return {
    ok: runnerRes.kind === "ok",
    reason: `bank: ${bankRes.reason} · runner: ${runnerRes.reason}`,
    bankOrderId,
    runnerOrderId: runnerRes.kind === "ok" ? runnerOrderId : undefined,
    runnerQty: runner.contracts,
  };
}

/** post ONE webhook leg with our order id (the runner-only fallback). */
async function postWebhookLeg(
  intent: OrderIntent,
  cfg: CrossTradeConfig,
  opts: { orderId: string; withTarget: boolean },
): Promise<{ ok: boolean; reason: string }> {
  let payload: CrossTradePayload;
  try {
    payload = buildCrossTradePayload(intent, cfg, opts);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return classifyResponse(res.status, await res.text());
  } catch (e) {
    return {
      ok: false,
      reason: `UNKNOWN (network: ${String(e)}) — check CrossTrade Alert History before acting; no automatic retry`,
    };
  }
}

/* ------------------------------------------------------------------ *
 * REST bracketless market EXIT — the time-exit path. Closes an open
 * position with a plain market order (no stop/target attached; the
 * entry's OCO brackets cancel when Tradovate flattens the position).
 * Dry-run unless EXECUTE_LIVE=1; UNKNOWN never auto-retries.
 * ------------------------------------------------------------------ */

export async function placeCrossTradeExitREST(
  intent: { symbol: string; dir: "long" | "short"; contracts: number },
): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) return { ok: false, reason: `crossTrade: cannot map symbol "${intent.symbol}"` };
  const qty = Math.max(1, Math.min(30, Math.floor(intent.contracts)));
  if (!live) {
    console.log(`[crossTrade] DRY-RUN(REST) EXIT ${intent.dir === "long" ? "SELL" : "BUY"} ${qty} ${instrument} (time exit)`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  const payload: Omit<RESTPlacePayload, "stopLoss"> = {
    instrument,
    action: intent.dir === "long" ? "sell" : "buy",
    qty,
    orderType: "market",
    tif: "day",
    orderId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-exit`,
  };
  console.log(`[crossTrade] LIVE(REST) EXIT ${payload.action.toUpperCase()} ${qty} ${instrument} (time exit)`);
  const leg = await postRESTLeg(payload, cfg);
  return leg.kind === "ok" ? { ok: true, reason: `REST exit placed ${payload.orderId}` } : { ok: false, reason: leg.reason };
}

/* ------------------------------------------------------------------ *
 * REST cancel — the resting-limit expiry path. Addresses the order by
 * OUR user-assigned orderId (the CrossTrade cancel route accepts either
 * the Tradovate numeric id or the user-assigned one). Dry-run unless
 * EXECUTE_LIVE=1; a failed cancel ALERTS the caller — a resting limit
 * that outlives its expiry must be cancelled by hand.
 * ------------------------------------------------------------------ */

export async function cancelCrossTradeOrderREST(orderId: string): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  if (!live) {
    console.log(`[crossTrade] DRY-RUN(REST) CANCEL ${orderId}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  try {
    const res = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/orders/${encodeURIComponent(orderId)}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const bodyText = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `cancel auth failure (${res.status})` };
    }
    let j: Record<string, unknown> | null = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      /* plain text */
    }
    if (!res.ok) return { ok: false, reason: `cancel rejected (${res.status}) ${bodyText.slice(0, 160)}` };
    if (j && j.success === false) {
      return { ok: false, reason: `cancel rejected: ${String(j.error ?? bodyText).slice(0, 160)}` };
    }
    return { ok: true, reason: `cancelled ${orderId}` };
  } catch (e) {
    return { ok: false, reason: `cancel UNKNOWN (network: ${String(e)}) — verify the order list manually` };
  }
}

/** TEST ONLY: reset the flat-entry latch. */
export function __resetLatchForTest() {
  entryPlacedAt = 0;
  awaitingFlat = false;
}

/* ------------------------------------------------------------------ *
 * Naked-position repair (2026-10-08 incident) — when a stop leg was
 * rejected or cancelled while the position is open, the protection
 * watchdog re-arms the bracket around the LIVE position via
 * cancel_and_bracket (cancels leftover working orders, wraps the open
 * position in a TP/SL OCO), and flattens when the re-arm fails. Both
 * are dry-run unless EXECUTE_LIVE=1; neither ever auto-retries on
 * UNKNOWN — the watchdog re-verifies on its next poll instead.
 * ------------------------------------------------------------------ */

/** pure payload builder for cancel_and_bracket (unit-tested). The re-arm
 *  wraps an OPEN position, so QTY is a required API field — the 2026-10-12
 *  recurrence disabled the naked-repair path exactly because the payload
 *  shipped without it (live 400: "Missing required field(s) for
 *  cancelandbracket: QTY"). Returns {error} instead of throwing so the
 *  caller can refuse cleanly. */
export function buildReArmBracketPayload(
  args: { symbol: string; dir: "long" | "short"; stopPrice: number; targetPrice: number; qty: number },
  cfg: CrossTradeConfig,
): { instrument: string; action: "buy" | "sell"; takeProfit: string; stopLoss: string; qty: number } | { error: string } {
  const instrument = mapInstrument(args.symbol, cfg.instrument);
  if (!instrument) return { error: `crossTrade: cannot map symbol "${args.symbol}"` };
  if (!Number.isFinite(args.stopPrice) || !Number.isFinite(args.targetPrice)) {
    return { error: `crossTrade: invalid re-arm bracket — stop ${args.stopPrice} target ${args.targetPrice}` };
  }
  if (!Number.isFinite(args.qty) || args.qty <= 0) {
    return { error: `crossTrade: invalid re-arm qty ${args.qty}` };
  }
  return {
    instrument,
    action: args.dir === "long" ? "buy" : "sell",
    takeProfit: args.targetPrice.toFixed(2),
    stopLoss: args.stopPrice.toFixed(2),
    qty: Math.floor(args.qty),
  };
}

/** re-arm a bracket around an OPEN position (cancel_and_bracket).
 *  `dir` names the PROTECTED side (long → action buy). The stop must be
 *  anchored beyond the CURRENT market or Tradovate rejects it again —
 *  the caller re-anchors it; the target is absolute and always valid.
 *  QTY is sized from the LIVE position when the caller omits it (an
 *  under/over-sized bracket is rejected or wrong). */
export async function rearmCrossTradeBracketREST(args: {
  symbol: string;
  dir: "long" | "short";
  stopPrice: number;
  targetPrice: number;
  qty?: number;
}): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  if (!live) {
    console.log(`[crossTrade] DRY-RUN(REST) RE-ARM ${args.dir} ${args.symbol} stop ${args.stopPrice.toFixed(2)} target ${args.targetPrice.toFixed(2)}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  let qty: number | null | undefined = args.qty;
  if (qty === undefined) {
    const held = await readMnqQtyREST();
    qty = held !== null ? Math.abs(held) : null;
  }
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "crossTrade: cannot size the re-arm — no open MNQ position to bracket" };
  }
  const payload = buildReArmBracketPayload({ ...args, qty }, cfg);
  if ("error" in payload) return { ok: false, reason: payload.error };
  try {
    const res = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/orders/cancel_and_bracket`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const bodyText = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `re-arm auth failure (${res.status})` };
    }
    let j: Record<string, unknown> | null = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      /* plain text */
    }
    if (!res.ok) return { ok: false, reason: `re-arm rejected (${res.status}) ${bodyText.slice(0, 160)}` };
    if (j && j.success === false) {
      return { ok: false, reason: `re-arm rejected: ${String(j.error ?? bodyText).slice(0, 160)}` };
    }
    return { ok: true, reason: `re-armed ${payload.instrument} ${args.dir}` };
  } catch (e) {
    return { ok: false, reason: `re-arm UNKNOWN (network: ${String(e)}) — verify the order list manually` };
  }
}

/** flatten the whole account (the last-resort repair when a naked
 *  position cannot be re-armed). Dry-run unless EXECUTE_LIVE=1. */
export async function flattenCrossTradePositionREST(): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  if (!live) {
    console.log(`[crossTrade] DRY-RUN(REST) FLATTEN ${cfg.account}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  try {
    const res = await fetch(
      `https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/positions/flatten`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const bodyText = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `flatten auth failure (${res.status})` };
    }
    let j: Record<string, unknown> | null = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      /* plain text */
    }
    if (!res.ok) return { ok: false, reason: `flatten rejected (${res.status}) ${bodyText.slice(0, 160)}` };
    if (j && j.success === false) {
      return { ok: false, reason: `flatten rejected: ${String(j.error ?? bodyText).slice(0, 160)}` };
    }
    return { ok: true, reason: "flattened" };
  } catch (e) {
    return { ok: false, reason: `flatten UNKNOWN (network: ${String(e)}) — flatten manually NOW` };
  }
}

/* ------------------------------------------------------------------ *
 * GLOBAL protection machinery (2026-10-08 naked-position incident).
 * Lives in the EXECUTOR, not in any feed family: every REST placement
 * (market or limit, any caller — current or future) registers its
 * intended bracket and verifies the OSO legs after placement, and the
 * watchdogs repair any open position that runs without a working stop.
 * The 30s account-level sweep lives in execWatch (checkProtection).
 * ------------------------------------------------------------------ */

/** the protection registry — the last successfully placed bracket on the
 *  account. The executor writes it on every placement; the watchdogs
 *  read it to know what a naked position SHOULD be protected with.
 *  rearmOk=false (scale-out) means repair-by-flatten only. */
export type OpenProtection = { intent: OrderIntent; rearmOk: boolean; at: number };

const gpProt = globalThis as unknown as {
  __gcOpenProtection?: OpenProtection | null;
};
export function openProtection(): OpenProtection | null {
  return gpProt.__gcOpenProtection ?? null;
}
export function setOpenProtection(p: OpenProtection | null): void {
  gpProt.__gcOpenProtection = p;
}
export function registerOpenProtection(intent: OrderIntent, opts: { rearmOk?: boolean } = {}): void {
  if (process.env.EXECUTE_LIVE !== "1") return;
  setOpenProtection({ intent, rearmOk: opts.rearmOk ?? true, at: Date.now() });
}

/** the tape price the dispatch/repair decisions anchor to (feed ltp, else
 *  the last closed minute — null when nothing is available). */
export function currentTapeLtp(): number | null {
  const live = getLive().state;
  const ltp = live.snapshot?.ltp ?? live.minutes.at(-1)?.c ?? null;
  return ltp !== null && Number.isFinite(ltp) ? ltp : null;
}

/** the emergency re-arm stop: anchored just beyond the CURRENT tape so
 *  Tradovate accepts it (a crossed stop is rejected with InvalidPrice).
 *  Pure + unit-tested. */
export function rearmStopPrice(dir: "long" | "short", ltp: number | null | undefined, padTicks = 4): number | null {
  if (ltp === null || ltp === undefined || !Number.isFinite(ltp)) return null;
  const pad = Math.max(1, Math.round(padTicks)) * 0.25;
  return dir === "long" ? ltp - pad : ltp + pad;
}

/** is the account flat on MNQ? true = confirmed flat, false = position
 *  open, null = unreadable (callers treat unreadable as "keep acting",
 *  never as "all clear"). */
export async function readMnqFlatREST(): Promise<boolean | null> {
  const cfg = loadConfig();
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/positions`, {
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (!j.success) return null;
    let qty = 0;
    for (const p of j.data ?? []) {
      if (!String(p.instrument ?? p.contractName ?? "").includes("MNQ")) continue;
      qty += Number(p.netPos ?? p.qty ?? 0);
    }
    return qty === 0;
  } catch {
    return null;
  }
}

/** signed MNQ net position qty from the same read as readMnqFlatREST —
 *  the re-arm's cancel_and_bracket QTY must match the OPEN position.
 *  null = unreadable (callers fall back or fail closed). */
export async function readMnqQtyREST(): Promise<number | null> {
  const cfg = loadConfig();
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(cfg.account)}/positions`, {
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
    if (!j.success) return null;
    let qty = 0;
    for (const p of j.data ?? []) {
      if (!String(p.instrument ?? p.contractName ?? "").includes("MNQ")) continue;
      qty += Number(p.netPos ?? p.qty ?? 0);
    }
    return qty;
  } catch {
    return null;
  }
}

/** repair a naked position: re-arm the bracket around the LIVE position
 *  (stop re-anchored just beyond the tape so it cannot be rejected
 *  again), verify the re-arm, and flatten when anything fails. Alerts at
 *  every step; callers throttle per episode. */
export async function repairNakedPosition(intent: OrderIntent, label: string, key: string): Promise<void> {
  const ltp = currentTapeLtp();
  const reg = openProtection();
  const rearmOk = reg?.rearmOk ?? true;
  const stopPrice = rearmStopPrice(intent.dir, ltp);
  if (rearmOk && stopPrice !== null) {
    const re = await rearmCrossTradeBracketREST({
      symbol: intent.symbol,
      dir: intent.dir,
      stopPrice,
      targetPrice: intent.target,
    });
    if (re.ok) {
      // the watchdog re-verifies the re-arm landed (working-stop read);
      // here we trust the accepted reply + the next poll
      void logExec({ key, label, attempt: "watch", outcome: "stop_rearmed", reason: `stop re-armed @ ${stopPrice.toFixed(2)} (target ${intent.target.toFixed(2)}) — ${re.reason}` });
      void sendTelegram(
        `🛡 <b>STOP RE-ARMED</b> — <code>${label}</code>\nthe position was running without a stop; a fresh bracket is working: stop ${stopPrice.toFixed(2)} · target ${intent.target.toFixed(2)}`,
        { parseMode: "HTML" },
      ).catch(() => {});
      return;
    }
    void logExec({ key, label, attempt: "watch", outcome: "stop_rearm_failed", reason: re.reason });
  } else if (rearmOk) {
    void logExec({ key, label, attempt: "watch", outcome: "stop_rearm_failed", reason: "no tape price to anchor the re-arm stop" });
  }
  // the position may have closed while we were reading (a fast target fill
  // OCO-cancels the stop and looks exactly like a naked position) — never
  // flatten a position that no longer exists
  const flat = await readMnqFlatREST();
  if (flat === true) {
    void logExec({ key, label, attempt: "watch", outcome: "stop_rearm_failed", reason: "position closed before repair — normal OCO, no action" });
    return;
  }
  const f = await flattenCrossTradePositionREST();
  void logExec({ key, label, attempt: "watch", outcome: f.ok ? "stop_flattened" : "stop_flatten_failed", reason: f.reason });
  void sendTelegram(
    f.ok
      ? `🚨 <b>NAKED POSITION FLATTENED</b> — <code>${label}</code>\nno working stop could be re-armed — the position was closed to protect the account.`
      : `🚨🚨 <b>NAKED POSITION — CLOSE MANUALLY NOW</b> — <code>${label}</code>\nre-arm AND flatten both failed (${f.reason}) — there is NO stop on this position.`,
    { parseMode: "HTML" },
  ).catch(() => {});
}

const BRACKET_VERIFY_FIRST_MS = 1500; // Tradovate's late rejections land ~10ms after accept — 1.5s catches them
const BRACKET_VERIFY_DELAY_MS = 4000;   // second, backstop check for slower risk-layer rejections

/** the latest entry-side fill since `sinceMs` (the fill-reconciled truth
 *  for where the trade actually got in — the re-anchor anchor). */
async function latestEntryFill(intent: OrderIntent, sinceMs: number): Promise<{ price: number } | null> {
  const cfg = loadConfig();
  const want = intent.dir === "long" ? "Buy" : "Sell";
  try {
    const res = await fetch("https://app.crosstrade.io/v1/api/tv/fills", {
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { data?: Array<{ data?: Array<Record<string, unknown>> }> };
    let best: { ts: number; price: number } | null = null;
    for (const env of j.data ?? []) {
      for (const f of env.data ?? []) {
        if (String(f.action) !== want) continue;
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        const price = Number(f.price);
        if (!Number.isFinite(price)) continue;
        if (!best || ts > best.ts) best = { ts, price };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** BURST verifier — the executor's post-placement protection loop.
 *  A trade is punctual, so the system polls like crazy for its first
 *  20 seconds: one session-orders read every ~1.5s shows the entry,
 *  stop and target states together (~13 calls per trade), then the 10s
 *  watchdog owns the rest of the trade's life. Stops the moment the
 *  bracket is confirmed (entry Filled + stop Working), acts instantly
 *  on a rejected/cancelled stop leg (cancel the resting entry, or
 *  repair the filled position), and runs the fill-anchored re-bracket
 *  check once the entry fills. Also registers the active bracket so
 *  the WebSocket order stream (lib/ctStream.ts) can react to pushed
 *  Rejected events without waiting for a poll. */
const BURST_FIRST_MS = 500;
const BURST_INTERVAL_MS = 1500;
const BURST_MAX_POLLS = 14;
const BURST_WINDOW_MS = 20_000;

export type ActiveBracket = {
  label: string;
  key: string;
  intent: OrderIntent;
  entryOrderId?: string;
  nativeEntryId?: string | number;
  stopChildId?: string | number;
  targetChildId?: string | number;
  placedAt: number;
};

const gpBracket = globalThis as unknown as { __gcActiveBracket?: ActiveBracket | null };
export function activeBracket(): ActiveBracket | null {
  return gpBracket.__gcActiveBracket ?? null;
}
export function setActiveBracket(b: ActiveBracket | null): void {
  gpBracket.__gcActiveBracket = b;
}

/** one session-orders read: every current-session order (all statuses —
 *  Rejected and Cancelled rows included) across the linked account. */
async function readSessionOrdersREST(): Promise<{ ok: boolean; rows: Array<Record<string, unknown>> }> {
  const cfg = loadConfig();
  try {
    const res = await fetch("https://app.crosstrade.io/v1/api/tv/orders", {
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<{ data?: Array<Record<string, unknown>> }> };
    if (!j.success) return { ok: false, rows: [] };
    const rows: Array<Record<string, unknown>> = [];
    for (const env of j.data ?? []) rows.push(...(env.data ?? []));
    return { ok: true, rows };
  } catch {
    return { ok: false, rows: [] };
  }
}

function findOrderRow(rows: Array<Record<string, unknown>>, id: string | number | undefined): Record<string, unknown> | null {
  if (id === undefined) return null;
  const s = String(id);
  return rows.find((r) => String(r.id ?? "") === s || String(r.clOrdId ?? "") === s) ?? null;
}

function rowStatus(r: Record<string, unknown> | null): string {
  if (!r) return "";
  return String(r.ordStatus ?? r.orderState ?? "");
}

const isBad = (s: string) => s === "Rejected" || s === "Canceled";
const isResting = (s: string) => s === "Working" || s === "OnHold" || s === "Suspended" || s === "";

/** the shared stop-leg-bad reaction (used by the burst poller AND the
 *  WebSocket stream): cancel a resting entry before it can fill naked,
 *  or repair the already-filled position. */
async function reactToBadStopLeg(o: ActiveBracket, entryStatus: string, stopStatus: string): Promise<void> {
  if (o.entryOrderId && isResting(entryStatus)) {
    const c = await cancelCrossTradeOrderREST(o.entryOrderId);
    void logExec({
      key: o.key,
      label: o.label,
      attempt: "watch",
      outcome: c.ok ? "bracket_rejected_cancel_entry" : "limit_cancel_failed",
      reason: `stop leg ${stopStatus} (entry ${entryStatus || "unknown"}) — ${c.reason}`,
    });
    void sendTelegram(
      `🚨 <b>STOP LEG ${stopStatus.toUpperCase()} AT PLACEMENT — entry cancelled</b> — <code>${o.label}</code>\n` +
        `Tradovate rejected the OSO stop (InvalidPrice risk) — the resting entry was cancelled so it cannot fill unprotected.` +
        (c.ok ? "" : `\n<b>CANCEL FAILED — verify manually NOW:</b> ${c.reason}`),
      { parseMode: "HTML" },
    ).catch(() => {});
    return;
  }
  // the entry already filled (or is a market entry we cannot cancel). A
  // fast full OCO cycle also lands here (target hit within seconds → the
  // stop shows Canceled with the account flat) — confirm a position
  // actually exists before repairing.
  const flat = await readMnqFlatREST();
  if (flat === true) {
    // the book went flat while we reacted — a fast OCO completion or the
    // owner's manual close. Until 2026-10-12 this branch returned
    // silently, which is exactly why the 10:28 repair left no trace.
    void logExec({
      key: o.key,
      label: o.label,
      attempt: "watch",
      outcome: "repair_aborted_flat",
      reason: `stop leg ${stopStatus} but the account is already flat (fast OCO or manual close) — no repair needed`,
    });
    return;
  }
  void logExec({ key: o.key, label: o.label, attempt: "watch", outcome: "stop_missing", reason: `stop leg ${stopStatus} after entry ${entryStatus}` });
  void repairNakedPosition(o.intent, o.label, o.key);
}

/** one burst poll: reads the session orders, decides, acts. Returns
 *  "done" when the bracket is confirmed or handled — the loop stops. */
async function burstPollOnce(o: ActiveBracket): Promise<"done" | "continue"> {
  const ords = await readSessionOrdersREST();
  if (!ords.ok) return "continue"; // unreadable — keep polling while the window lasts
  const entry = findOrderRow(ords.rows, o.nativeEntryId !== undefined ? o.nativeEntryId : o.entryOrderId);
  const stop = findOrderRow(ords.rows, o.stopChildId);
  const target = findOrderRow(ords.rows, o.targetChildId);
  const entryStatus = rowStatus(entry);
  const stopStatus = rowStatus(stop);
  const targetStatus = rowStatus(target);

  if (isBad(stopStatus)) {
    await reactToBadStopLeg(o, entryStatus, stopStatus);
    return "done";
  }
  if (isBad(entryStatus)) return "done"; // entry rejected/cancelled — nothing will fill
  if (isBad(targetStatus) && !isBad(stopStatus)) {
    void logExec({ key: o.key, label: o.label, attempt: "watch", outcome: "target_missing", reason: `target leg ${targetStatus} — stop remains working` });
    void sendTelegram(`⚠️ <b>TARGET LEG ${targetStatus.toUpperCase()}</b> — <code>${o.label}</code>\nstop remains working; the trade will exit at the stop or by time.`, { parseMode: "HTML" }).catch(() => {});
    return "done";
  }
  if (entryStatus === "Filled" && !isBad(stopStatus)) {
    // healthy bracket, entry filled → fill-anchored re-bracket
    // (2026-10-08 −$1,056 stop-slippage incident): if the fill drifted
    // past the signal, the signal-anchored stop is compressed (the 12:16
    // card's 3.2-pt stop became 0.8 pts) and a flush runs it over with
    // huge slippage. Re-anchor the bracket to the ACTUAL fill so the
    // planned risk is the risk the trade carries.
    const fill = await latestEntryFill(o.intent, Date.now() - 30_000);
    if (fill) {
      const reanchor = reanchorBracketForFill(o.intent, fill.price);
      if (reanchor) {
        const re = await rearmCrossTradeBracketREST({
          symbol: o.intent.symbol,
          dir: o.intent.dir,
          stopPrice: reanchor.stop,
          targetPrice: reanchor.target,
        });
        void logExec({
          key: o.key,
          label: o.label,
          attempt: "watch",
          outcome: re.ok ? "bracket_reanchored" : "stop_rearm_failed",
          reason: re.ok
            ? `fill ${fill.price.toFixed(2)} drifted past the signal — stop re-anchored ${reanchor.stop.toFixed(2)} · target ${reanchor.target.toFixed(2)} — ${re.reason}`
            : `re-anchor failed: ${re.reason}`,
        });
        void sendTelegram(
          re.ok
            ? `⚓ <b>BRACKET RE-ANCHORED TO THE FILL</b> — <code>${o.label}</code>\nfill ${fill.price.toFixed(2)} drifted from the signal ${o.intent.entry.toFixed(2)} — stop moved to ${reanchor.stop.toFixed(2)} · target ${reanchor.target.toFixed(2)} so the planned risk holds.`
            : `🚨 <b>RE-ANCHOR FAILED</b> — <code>${o.label}</code>\nfill drifted and the compressed bracket could not be re-anchored (${re.reason}) — the watchdog will repair if the stop is missing.`,
          { parseMode: "HTML" },
        ).catch(() => {});
        return "done"; // the bracket ids changed with the re-arm — stop checking the old ones
      }
    }
    return "done"; // confirmed healthy — the 10s watchdog owns the rest of the trade's life
  }
  return "continue"; // entry still resting — keep polling within the window
}

export function verifyBracketsAfterPlace(o: {
  label: string;
  key: string;
  intent: OrderIntent;
  entryOrderId?: string;
  nativeEntryId?: string | number;
  stopChildId?: string | number;
  targetChildId?: string | number;
}): void {
  if (process.env.EXECUTE_LIVE !== "1") return;
  if (o.stopChildId === undefined && o.targetChildId === undefined && o.nativeEntryId === undefined) return;
  const b: ActiveBracket = { ...o, placedAt: Date.now() };
  setActiveBracket(b); // the WebSocket stream reacts to pushed events against this
  let polls = 0;
  let started = 0;
  const run = async () => {
    if (polls >= BURST_MAX_POLLS || (started && Date.now() - started > BURST_WINDOW_MS)) return;
    if (!started) started = Date.now();
    polls += 1;
    const verdict = await burstPollOnce(b);
    if (verdict === "continue") setTimeout(() => void run(), BURST_INTERVAL_MS);
    else setActiveBracket(null); // confirmed or handled — no further checks on these ids
  };
  setTimeout(() => void run(), BURST_FIRST_MS);
}

/** the WebSocket order stream calls this when a Tradovate order event
 *  reports a stop-leg Rejected — react immediately, without waiting for
 *  the next poll. Two cases: the active just-placed bracket (burst
 *  window) and a mid-trade rejection of a tracked position's stop
 *  (evidence-checked: only acts when no working stop covers the side). */
export async function reactToPushedStopRejection(stopId: string | number, orderAction?: string): Promise<void> {
  const b = activeBracket();
  if (b && b.stopChildId !== undefined && String(b.stopChildId) === String(stopId)) {
    setActiveBracket(null);
    const entryStatus = await (async () => {
      if (b.nativeEntryId === undefined && !b.entryOrderId) return "";
      try {
        const ords = await readSessionOrdersREST();
        if (!ords.ok) return "";
        return rowStatus(findOrderRow(ords.rows, b.nativeEntryId !== undefined ? b.nativeEntryId : b.entryOrderId));
      } catch {
        return "";
      }
    })();
    await reactToBadStopLeg(b, entryStatus, "Rejected");
    return;
  }
  // mid-trade: a tracked position exists and the stop-side order was
  // rejected. Act only when the evidence agrees — the working-stop read
  // must show nothing covering the position (never trust a stray event).
  const reg = openProtection();
  if (!reg) return;
  const stopSide = reg.intent.dir === "long" ? "Sell" : "Buy";
  if (orderAction && String(orderAction).toLowerCase() !== stopSide.toLowerCase()) return;
  const ords = await readSessionOrdersREST();
  if (!ords.ok) return;
  const hasStop = ords.rows.some((r) => {
    const st = rowStatus(r);
    const isStopRow = r.stopPrice !== undefined || String(r.orderType ?? "").toLowerCase().includes("stop");
    return (st === "Working" || st === "OnHold" || st === "Suspended") && String(r.action ?? "").toLowerCase() === stopSide.toLowerCase() && isStopRow;
  });
  if (hasStop) return; // another stop still covers the position — ignore
  const flat = await readMnqFlatREST();
  if (flat !== false) return; // no open position — nothing to repair
  void logExec({ key: `protect|${Date.now()}`, label: "protection stream", attempt: "watch", outcome: "stop_missing", reason: `stop leg ${stopId} Rejected mid-trade (WS event)` });
  void repairNakedPosition(reg.intent, "protection stream", `protect|${Date.now()}`);
}
