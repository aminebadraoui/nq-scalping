import { dbEnabled, getDb } from "@/lib/gcdb";
import { adminUnauthorized, isAdminRequest } from "@/lib/adminAuth";

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

/** Weekly reviews + the next-week experiment queue + the backtest-source
 *  proposals the surface can act on.
 *  GET /api/weekly-review            → latest week's full review + experiments
 *  GET /api/weekly-review?week=…     → that week's full review
 *  POST {action:"queue"|"unqueue"|"skip", id} → experiment state changes
 *  (the proposal apply/reject actions stay on POST /api/insights). */
export async function GET(req: Request) {
  if (!dbEnabled()) return Response.json({ ok: false, reason: "no DATABASE_URL" });
  const db = getDb();
  const url = new URL(req.url);
  const weekParam = url.searchParams.get("week") ?? "";

  try {
    // degrade gracefully on a fresh DB (weekly_reviews is created by the
    // Saturday job's first run — before that, the surface shows the empty state)
    let weeks: Row[] = [];
    try {
      weeks = (await db`
        select week_start::text as week_start, week_end::text as week_end, generated_at,
               coalesce((stats->'trades'->>'count')::int, 0) as trades,
               coalesce((stats->'trades'->'overall'->>'netUsd')::numeric, 0) as net
        from weekly_reviews order by week_start desc limit 12`) as Row[];
    } catch {
      /* table missing — first Saturday run creates it */
    }

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

    // the next-week experiment queue: proposed (LLM hypotheses), queued
    // (waiting for the next Saturday), recently ran/skipped.
    let experiments: Row[] = [];
    try {
      experiments = (await db`
        select id, created_at, week_start::text as week_start, title, study, args, rationale, status, source, ran_at, result
        from weekly_experiments
        where status in ('proposed', 'queued') or (status in ('ran', 'skipped') and created_at > now() - interval '28 days')
        order by case status when 'queued' then 0 when 'proposed' then 1 else 2 end, id desc`) as Row[];
    } catch {
      /* table may not exist yet (pre-Phase-3 deploy or fresh DB) */
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
      experiments: experiments.map((r) => ({
        id: Number(r.id),
        created_at: String(r.created_at),
        week_start: String(r.week_start),
        title: String(r.title),
        study: String(r.study),
        args: parseJson<string[]>(r.args) ?? [],
        rationale: String(r.rationale ?? ""),
        status: String(r.status),
        source: String(r.source ?? "llm"),
        ran_at: r.ran_at ? String(r.ran_at) : null,
        result: parseJson(r.result),
      })),
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

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  if (!dbEnabled()) return Response.json({ ok: false, reason: "no DATABASE_URL" });
  const db = getDb();
  let body: { action?: string; id?: number } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" });
  }
  const { action, id } = body;
  if (!id) return Response.json({ ok: false, reason: "id is required" });

  try {
    if (action === "queue") {
      const r = await db`
        update weekly_experiments set status = 'queued' where id = ${id} and status = 'proposed' returning id`;
      if (r.length === 0) return Response.json({ ok: false, reason: "experiment not found or not proposed" });
      return Response.json({ ok: true });
    }
    if (action === "unqueue") {
      const r = await db`
        update weekly_experiments set status = 'proposed' where id = ${id} and status = 'queued' returning id`;
      if (r.length === 0) return Response.json({ ok: false, reason: "experiment not found or not queued" });
      return Response.json({ ok: true });
    }
    if (action === "skip") {
      const r = await db`
        update weekly_experiments set status = 'skipped' where id = ${id} and status in ('proposed', 'queued') returning id`;
      if (r.length === 0) return Response.json({ ok: false, reason: "experiment not found or not skippable" });
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, reason: `unknown action "${action ?? ""}"` });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
