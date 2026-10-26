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

/** Insights + the self-improvement overrides: GET lists the latest findings
 *  and active gates; POST applies / rejects a proposal (the human side of the
 *  loop — the nightly miner proposes, the dashboard approves). */
export async function GET() {
  if (!dbEnabled()) return Response.json({ ok: false, reason: "no DATABASE_URL" });
  const db = getDb();
  try {
    const insights = await db`
      select id, run_at, strategy, kind, severity, title, finding, evidence, proposed_action, auto_apply, status, source
      from insights order by run_at desc, id desc limit 40`;
    const overrides = await db`
      select o.id, o.created_at, o.applied_at, o.family, o.gate, o.value, o.active, o.note, o.insight_id, i.title as insight_title
      from strategy_overrides o left join insights i on i.id = o.insight_id
      order by o.created_at desc`;
    const json = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
    return Response.json({
      ok: true,
      insights: insights.map((r) => ({
        ...r,
        evidence: parseJson(r.evidence) ?? {},
        proposedAction: parseJson(r.proposed_action),
      })),
      overrides: overrides.map((r) => ({ ...r, value: json(r.value) })),
    });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  if (!dbEnabled()) return Response.json({ ok: false, reason: "no DATABASE_URL" });
  const db = getDb();
  let body: { action?: string; id?: number; overrideId?: number } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" });
  }
  const { action, id, overrideId } = body;

  try {
    if (action === "apply" && id) {
      const rows = (await db`select * from insights where id = ${id}`) as unknown as Row[];
      const ins = rows[0];
      if (!ins) return Response.json({ ok: false, reason: "insight not found" });
      if (ins.status !== "proposed") return Response.json({ ok: false, reason: `insight is ${ins.status}` });
      const pa = parseJson<{ family: string; gate: string; value: unknown; note: string }>(ins.proposed_action);
      if (!pa) return Response.json({ ok: false, reason: "insight has no proposed action" });
      await db`
        insert into strategy_overrides (insight_id, family, gate, value, active, note, applied_at)
        values (${id}, ${pa.family}, ${pa.gate}, ${JSON.stringify(pa.value)}, true, ${pa.note}, now())`;
      await db`update insights set status = 'applied' where id = ${id}`;
      return Response.json({ ok: true, applied: { family: pa.family, gate: pa.gate, value: pa.value } });
    }

    if (action === "reject" && id) {
      await db`update insights set status = 'rejected' where id = ${id}`;
      return Response.json({ ok: true });
    }

    if (action === "disable" && overrideId) {
      await db`update strategy_overrides set active = false where id = ${overrideId}`;
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, reason: `unknown action "${action ?? ""}"` });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
