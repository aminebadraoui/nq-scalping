/* ------------------------------------------------------------------ *
 * /api/executions — the live execution ledger (lib/execTracker.ts):
 * one row per executed signal with its Tradovate order/fill identity
 * and the money result (net = gross − fees).
 *
 * Read-only, display-only. No secrets leave the server (no order
 * payloads, no keys — only ids/prices/quantities/results).
 * ------------------------------------------------------------------ */

import { getExecTrades } from "@/lib/execTracker";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await getExecTrades(300);
  const closed = rows.filter((r) => r.status === "closed");
  const net = Math.round(closed.reduce((s, r) => s + r.netUsd, 0) * 100) / 100;
  const wins = closed.filter((r) => r.result === "win").length;
  const losses = closed.filter((r) => r.result === "loss").length;
  return Response.json({
    ok: true,
    rows,
    summary: { n: rows.length, closed: closed.length, wins, losses, netUsd: net },
    note:
      "live intraday view — scripts/reconcileTrades.ts remains the nightly historical record",
  });
}
