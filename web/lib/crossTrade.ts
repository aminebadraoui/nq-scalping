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
  take_profit: string;
  require_market_position?: string;
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
 */
export function buildCrossTradePayload(intent: OrderIntent, cfg: CrossTradeConfig): CrossTradePayload {
  const instrument = mapInstrument(intent.symbol, cfg.instrument);
  if (!instrument) {
    throw new Error(`crossTrade: cannot map symbol "${intent.symbol}" to a Tradovate instrument`);
  }
  const qty = Math.max(1, Math.min(30, Math.floor(intent.contracts)));
  const stopTicks = ticksFromPoints(Math.abs(intent.entry - intent.stop));
  const targetTicks = ticksFromPoints(Math.abs(intent.target - intent.entry));
  if (!Number.isFinite(stopTicks) || !Number.isFinite(targetTicks) || stopTicks < 1 || targetTicks < 1) {
    throw new Error(
      `crossTrade: invalid bracket — entry ${intent.entry} stop ${intent.stop} target ${intent.target}`,
    );
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
    take_profit: `${targetTicks} ticks`,
  };
  if (cfg.requireFlat) payload.require_market_position = "flat";
  return payload;
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
