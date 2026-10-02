import { dbEnabled, getDb } from "@/lib/gcdb";

export const dynamic = "force-dynamic";

/** Reconciled trades (scripts/reconcileTrades.ts output): the latest run's
 *  summary plus its signal↔fill rows — the dashboard's trade review panel.
 *  Data-only: no live feed, no execution state. */
export async function GET() {
  if (!dbEnabled()) {
    return Response.json({ ok: false, reason: "no DATABASE_URL" });
  }
  const db = getDb();
  try {
    const runs = await db`select * from reconcile_runs order by run_at desc limit 5`;
    let trades: unknown = [];
    if (runs.length) {
      const latest = runs[0];
      trades = await db`
        select * from trades
        where ts >= ${Number(latest.window_start)} and ts <= ${Number(latest.window_end)}
        order by ts asc`;
    }
    const analysis = await db`select * from trade_analysis order by run_at desc limit 1`;
    const a = analysis[0] as (typeof analysis)[number] | undefined;
    return Response.json({
      ok: true,
      runs,
      trades,
      analysis: a
        ? {
            ...a,
            summary: typeof a.summary === "string" ? JSON.parse(a.summary) : a.summary,
          }
        : null,
    });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
