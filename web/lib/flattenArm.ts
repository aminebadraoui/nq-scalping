/* ------------------------------------------------------------------ *
 * Flatten arm — the day-target / day-loss INSTANT FLATTEN (2026-10-12).
 *
 * The live day plan halts NEW entries at the daily loss floor / profit
 * arm, but the OPEN position runs to its bracket — so the realized
 * worst day can overshoot the floor by one trade's loss (measured
 * 2026-10-12: −$339 at a −$250 floor). This module adds the closing
 * side: once the day's LIVE P&L (realized + open) crosses
 * FLATTEN_AT_PROFIT or −FLATTEN_AT_LOSS, the account is flattened at
 * market instead of only halting.
 *
 * Division of labor (no import cycles):
 *   · THIS module — the pure decision (flattenArmStep) and the pure
 *     webhook payload builders. Imports nothing from the repo.
 *   · lib/accountGuard.ts — adds the "flatten" verdict + the
 *     once-per-day latch (persisted in the guard state).
 *   · lib/crossTrade.ts — flattenViaWebhook / flattenArmFire, the I/O:
 *     cancel-all + FLATTEN webhook (or the REST flatten), flat-verify,
 *     retry once, then the manual-flatten alert.
 *   · lib/crossGuard.ts — calls the fire function when the verdict
 *     fires (via dynamic import — crossTrade imports crossGuard, so the
 *     reverse edge is loaded lazily to keep the static graph acyclic).
 *
 * OFF BY DEFAULT: FLATTEN_AT_PROFIT / FLATTEN_AT_LOSS both default to 0
 * (no-op), and every fire path honors the EXECUTE_LIVE dry-run gate.
 * Unit-tested in tests/flattenArm.test.ts.
 * ------------------------------------------------------------------ */

export type FlattenArmConfig = {
  /** live P&L at/above which the day flattens (0 = off) */
  flattenAtProfit: number;
  /** live P&L at/below −this at which the day flattens (0 = off) */
  flattenAtLoss: number;
};

export type FlattenArmStep = {
  fire: "none" | "profit" | "loss";
  /** day realized P&L + open P&L (the number the thresholds read) */
  livePnl: number;
  reason: string;
};

/**
 * The pure decision. `dayPnl` is the guard's realized day P&L;
 * `openPnl` the live open P&L from the account snapshot (undefined/NaN
 * treated as 0 — realized-only). `firedDay` is the day key on which the
 * arm already fired ("" = never) — once fired, it stays latched for the
 * whole trading day so a flat account can never re-trigger it.
 */
export function flattenArmStep(
  cfg: FlattenArmConfig,
  dayPnl: number,
  openPnl: number | undefined,
  firedDay: string | undefined,
  dayKey: string,
): FlattenArmStep {
  const livePnl = dayPnl + (Number.isFinite(openPnl) ? (openPnl as number) : 0);
  const fired = (firedDay ?? "") === dayKey;
  if (fired) {
    return { fire: "none", livePnl, reason: `already fired on ${dayKey}` };
  }
  if (cfg.flattenAtLoss > 0 && livePnl <= -cfg.flattenAtLoss) {
    return {
      fire: "loss",
      livePnl,
      reason: `live P&L $${livePnl.toFixed(0)} ≤ −$${cfg.flattenAtLoss.toFixed(0)} (FLATTEN_AT_LOSS) — flatten the day`,
    };
  }
  if (cfg.flattenAtProfit > 0 && livePnl >= cfg.flattenAtProfit) {
    return {
      fire: "profit",
      livePnl,
      reason: `live P&L $${livePnl.toFixed(0)} ≥ +$${cfg.flattenAtProfit.toFixed(0)} (FLATTEN_AT_PROFIT) — flatten the day`,
    };
  }
  return { fire: "none", livePnl, reason: "" };
}

/** true when either side of the arm is enabled */
export function flattenArmEnabled(cfg: FlattenArmConfig): boolean {
  return cfg.flattenAtProfit > 0 || cfg.flattenAtLoss > 0;
}

/* ---------------- webhook payloads (pure builders) ---------------- */

export type FlattenWebhookPayload = {
  key: string;
  command: "flatten";
  account: string;
  destination: "tradovate";
};

export type CancelAllWebhookPayload = {
  key: string;
  command: "cancelallorders";
  account: string;
  destination: "tradovate";
};

/** FLATTEN — close the linked account's position at market
 *  (CrossTrade command vocabulary; account scopes it to the linked MFF
 *  account). */
export function buildFlattenWebhookPayload(cfg: { key: string; account: string }): FlattenWebhookPayload {
  if (!cfg.key.trim() || !cfg.account.trim()) {
    throw new Error("flattenArm: webhook flatten needs key + account");
  }
  return { key: cfg.key, command: "flatten", account: cfg.account, destination: "tradovate" };
}

/** CANCELALLORDERS — kill the resting brackets so the flatten's market
 *  exit is the last order standing. */
export function buildCancelAllWebhookPayload(cfg: { key: string; account: string }): CancelAllWebhookPayload {
  if (!cfg.key.trim() || !cfg.account.trim()) {
    throw new Error("flattenArm: cancel-all needs key + account");
  }
  return { key: cfg.key, command: "cancelallorders", account: cfg.account, destination: "tradovate" };
}
