/* ------------------------------------------------------------------ *
 * /api/manual — the manual-action detector's record (lib/manualDetect.ts):
 * manual MNQ round trips + working orders the bot never placed, with
 * entry/exit prices and net $ where the fills close the trip.
 *
 * Read-only, display-only. No secrets leave the server.
 * ------------------------------------------------------------------ */

import { getManualActions } from "@/lib/manualDetect";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await getManualActions(200);
  const trades = rows.filter((r) => r.kind === "manual_trade");
  const orders = rows.filter((r) => r.kind === "manual_order");
  const closed = trades.filter((r) => r.closed);
  const netUsd = Math.round(closed.reduce((s, r) => s + (r.pnlUsd ?? 0), 0) * 100) / 100;
  return Response.json({
    ok: true,
    rows,
    summary: {
      n: rows.length,
      trades: trades.length,
      open: trades.filter((r) => !r.closed).length,
      orders: orders.length,
      netUsd,
    },
    note: "every MNQ fill/order the bot cannot account for — entries, exits, flattens, resting orders",
  });
}
