import { dbEnabled, getDb } from "@/lib/gcdb";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  try {
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
  } catch {
    return null;
  }
}

/** Weekly reviews + the backtest-source proposals the surface can act on.
 *  GET /api/weekly-review            → latest week's full review + the week list
 *  GET /api/weekly-review?week=…     → that week's full review */
export async function GET(req: Request) {
  if (!dbEnabled()) return Response.json({ ok: false, reason: "no DATABASE_URL" });
  const db = getDb();
  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week") ?? "";

  try {
    const weeks = (await db`
      select week_start::text as week_start, week_end::text as week_end, generated_at,
             coalesce((stats->'trades'->>'count')::int, 0) as trades,
             coalesce((stats->'trades'->'overall'->>'netUsd')::numeric, 0) as net
      from weekly_reviews order by week_start desc limit 12`) as Row[];

    const target = weekParam || (weeks[0] ? String(weeks[0].week_start) : "");
    let review: Row | null = null;
    if (target) {
      const rows = (await db`
        select id, week_start::text as week_start, week_end::text as week_end, generated_at, sha, stats, studies, narrative, narrative_source, telegram_sent
        from weekly_reviews where week_start = ${target}::date limit 1`) as Row[];
      const r = rows[0];
      if (r) {
        review = {
          id: r.id,
          week_start: r.week_start,
          week_end: r.week_end,
          generated_at: r.generated_at,
          sha: r.sha,
          stats: parseJson(r.stats) ?? null,
          studies: parseJson(r.studies) ?? [],
          narrative: String(r.narrative ?? ""),
          narrative_source: r.narrative_source,
          telegram_sent: !!r.telegram_sent,
        };
      }
    }

    // backtest-source proposals (promoteFromBacktest / the weekly job write
    // these) — the apply/reject actions reuse POST /api/insights.
    const insightRows = (await db`
      select id, run_at, strategy, kind, severity, title, finding, evidence, proposed_action, auto_apply, status, source
      from insights where source = 'backtest' order by run_at desc, id desc limit 20`) as Row[];

    return Response.json({
      ok: true,
      weeks: weeks.map((w) => ({
        week_start: String(w.week_start),
        week_end: String(w.week_end),
        generated_at: w.generated_at,
        trades: Number(w.trades),
        net: Number(w.net),
      })),
      review,
      insights: insightRows.map((r) => ({
        ...r,
        evidence: parseJson(r.evidence) ?? {},
        proposedAction: parseJson(r.proposed_action),
      })),
    });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
