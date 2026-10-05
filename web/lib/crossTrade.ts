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
import { quoteAgreeGate } from "./quoteGate";

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
 * Pure — no env, no I/O — so it is unit-testable. Throws on inputs
 * that would produce an invalid order instead of guessing.
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
  const qty = Math.max(1, Math.min(30, Math.floor(intent.contracts)));
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
    return classifyResponse(res.status, await res.text());
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
  if (ok) markEntryPlaced();
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
 *  cancel route accepts the user-assigned orderId). */
export async function placeCrossTradeOrderREST(
  intent: OrderIntent,
  opts: { limitPrice?: number } = {},
): Promise<{ ok: boolean; reason: string; orderId?: string }> {
  const guard = await crossGuardGate();
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    return { ok: false, reason: `crossTrade: cannot map symbol "${intent.symbol}" to a Tradovate instrument` };
  }
  const orderId = opts.limitPrice !== undefined ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-lmt` : undefined;
  if (!live) {
    console.log(
      `[crossTrade] DRY-RUN(REST) ${opts.limitPrice !== undefined ? "LIMIT" : ""} ${describeIntent(intent)}` +
        (opts.limitPrice !== undefined ? ` @ ${opts.limitPrice.toFixed(2)}` : ""),
    );
    return { ok: true, reason: "dry-run (logged only)", orderId };
  }

  // broker quote agreement — the tape can lag the real market (2026-10-04:
  // tape 31141 vs broker 31155 → market fill above the take-profit → instant
  // OCO close). Refuse when the broker quote disagrees with the signal.
  const qg = await quoteAgreeGate(cfg, intent.entry, instrument);
  if (!qg.ok) return { ok: false, reason: qg.reason };

  const flat = await restFlatGate(cfg);
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
  const leg = await postRESTLeg(payload, cfg);
  if (leg.kind === "auth") {
    // plan/auth rejections happen BEFORE dispatch — safe to fall back to
    // the webhook path exactly once (nothing was placed)
    console.warn(`[crossTrade] REST unavailable (${leg.reason}) — falling back to the webhook path`);
    return placeCrossTradeOrder(intent);
  }
  if (leg.kind !== "ok") return { ok: false, reason: leg.reason };
  markEntryPlaced();
  return { ok: true, reason: `REST placed ${payload.orderId ?? ""}`, orderId };
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
  const qty = Math.max(1, Math.min(30, Math.floor(intent.contracts)));
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

type RESTLegResult = { kind: "ok" | "auth" | "rejected" | "unknown"; reason: string };

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
    return { kind: "ok", reason: bodyText.slice(0, 120) };
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
  const guard = await crossGuardGate();
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
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
  if (!live) {
    console.log(
      `[crossTrade] DRY-RUN(REST) SCALE-OUT ${intent.dir.toUpperCase()} ${intent.contracts} ${intent.symbol} ` +
        `→ bank ${bank.contracts} (1R) + runner ${runner.contracts} (ladder) · ${intent.timeET} NY`,
    );
    return { ok: true, reason: "dry-run (logged only)", bankOrderId, runnerOrderId, runnerQty: runner.contracts };
  }

  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    return { ok: false, reason: `crossTrade: cannot map symbol "${intent.symbol}" to a Tradovate instrument` };
  }
  const qg = await quoteAgreeGate(cfg, intent.entry, instrument);
  if (!qg.ok) return { ok: false, reason: qg.reason };

  const flat = await restFlatGate(cfg);
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
    return {
      ok: w.ok,
      reason: `bank: ${bankRes.reason} · runner(webhook): ${w.reason}`,
      bankOrderId,
      runnerOrderId: w.ok ? runnerOrderId : undefined,
      runnerQty: runner.contracts,
    };
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
