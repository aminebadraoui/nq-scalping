/* ------------------------------------------------------------------ *
 * CrossTrade executor — places trade orders on the MFF Tradovate
 * account via the CrossTrade cloud webhook. No Tradovate API key is
 * needed on our side: CrossTrade is an approved Tradovate OAuth
 * partner and routes server-side; the linked account is addressed
 * with `destination=tradovate` and the order is flagged isAutomated
 * by them. No browser, no VPS, no NinjaTrader install — one HTTP POST
 * from the signal feed at the moment the card fires.
 *
 * This path REPLACES the Playwright browser path (lib/executor.ts)
 * whenever CROSSTRADE_KEY is configured. The same EXECUTE_LIVE gate
 * applies: dry-run (log only) until EXECUTE_LIVE=1.
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
 * ------------------------------------------------------------------ */

import type { OrderIntent } from "./executor";
import { crossGuardGate } from "./crossGuard";

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
  return { ok: true, reason: `accepted (${status})${body ? ` ${body}` : ""}` };
}

/**
 * Send the order intent to the CrossTrade webhook. Dry-run (log only)
 * unless EXECUTE_LIVE=1 — the same gate as the Playwright path, so the
 * two backends are interchangeable without extra switches.
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

/** place a bracketed market order with ABSOLUTE stop/target prices */
export async function placeCrossTradeOrderREST(
  intent: OrderIntent,
): Promise<{ ok: boolean; reason: string }> {
  const guard = await crossGuardGate();
  if (guard.verdict !== "ok") return { ok: false, reason: `guard: ${guard.reason}` };
  const cfg = loadConfig();
  const live = process.env.EXECUTE_LIVE === "1";
  if (!live) {
    console.log(`[crossTrade] DRY-RUN(REST) ${describeIntent(intent)}`);
    return { ok: true, reason: "dry-run (logged only)" };
  }
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    return { ok: false, reason: `crossTrade: cannot map symbol "${intent.symbol}"` };
  }
  const qty = Math.max(1, Math.min(30, Math.floor(intent.contracts)));

  const key = cfg.key;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const account = cfg.account;

  // ---- flat check (require_market_position=flat equivalent) ----
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/positions`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> | Array<{ data?: Array<Record<string, unknown>> }> };
    if (!j.success) return { ok: false, reason: `crossTrade: flat check failed — ${JSON.stringify(j).slice(0, 160)}` };
    const flat: unknown[] = [];
    for (const row of (j.data ?? []) as Array<Record<string, unknown>>) {
      const inner = Array.isArray(row.data) ? (row.data as Array<Record<string, unknown>>) : [row];
      flat.push(...inner);
    }
    const held = flat.filter((p) => {
      const r = p as Record<string, unknown>;
      const qty = Number(r.netPos ?? r.qty ?? 0);
      const ins = String(r.instrument ?? r.contractName ?? "");
      return qty !== 0 && ins.includes("MNQ");
    });
    if (held.length > 0) {
      return { ok: false, reason: "crossTrade: not flat — an MNQ position is open (refusing)" };
    }
  } catch (e) {
    return { ok: false, reason: `crossTrade: cannot verify flat state (${String(e)}) — refusing` };
  }

  // ---- absolute bracket placement ----
  const orderId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    instrument,
    action: intent.dir === "long" ? "buy" : "sell",
    qty,
    orderType: "market",
    tif: "day",
    takeProfit: intent.target.toFixed(2), // ABSOLUTE — the signal's structural target
    stopLoss: intent.stop.toFixed(2), // ABSOLUTE — the signal's structural stop
    orderId,
  };
  console.log(
    `[crossTrade] LIVE(REST) ${intent.dir.toUpperCase()} ${qty} ${instrument} ` +
      `entry ${intent.entry.toFixed(2)} · stop ${intent.stop.toFixed(2)} · target ${intent.target.toFixed(2)} · ${intent.timeET} NY`,
  );
  try {
    const res = await fetch(`https://app.crosstrade.io/v1/api/tv/accounts/${encodeURIComponent(account)}/orders/place`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const bodyText = await res.text();
    let j: Record<string, unknown> | null = null;
    try {
      j = JSON.parse(bodyText);
    } catch {
      /* plain text */
    }
    // plan/auth rejections happen BEFORE dispatch — safe to fall back to
    // the webhook path exactly once (nothing was placed)
    if (res.status === 401 || res.status === 403) {
      console.warn(`[crossTrade] REST unavailable (${res.status}) — falling back to the webhook path`);
      return placeCrossTradeOrder(intent);
    }
    if (!res.ok) return { ok: false, reason: `REST rejected (${res.status}) ${bodyText.slice(0, 200)}` };
    if (j && j.success === false) {
      return { ok: false, reason: `REST rejected: ${String(j.error ?? bodyText).slice(0, 200)}` };
    }
    return { ok: true, reason: `REST placed ${orderId}` };
  } catch (e) {
    return {
      ok: false,
      reason: `REST UNKNOWN (network: ${String(e)}) — reconcile before acting; no automatic retry`,
    };
  }
}
