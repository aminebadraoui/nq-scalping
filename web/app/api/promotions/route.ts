import { dbEnabled, getDb } from "@/lib/gcdb";
import { studies, CATEGORIES } from "@/lib/studies";
import { statusFor, type PromotionRunRow } from "@/lib/promotionLedger";

export const dynamic = "force-dynamic";

/** The promotion pipeline state — one payload the /promotions surface
 *  renders: the committed study catalog × every contract verdict (pass
 *  AND reject) × the live override rows × the Kelly knob state. */
export async function GET() {
  const payload: {
    ok: boolean;
    studies: unknown[];
    runs: PromotionRunRow[];
    overrides: unknown[];
    kelly: Record<string, string | boolean>;
    counts: Record<string, number>;
  } = {
    ok: false,
    studies: [],
    runs: [],
    overrides: [],
    kelly: {},
    counts: { promoted: 0, rejected: 0, research: 0, activeOverrides: 0 },
  };

  // the committed catalog is always available, DB or not
  payload.studies = studies.map((s) => {
    const st = statusFor(payload.runs, s.script);
    return {
      id: s.id,
      title: s.title,
      date: s.date,
      category: s.category,
      script: s.script,
      doc: s.doc,
      status: st.status,
      run: st.run,
    };
  });

  if (!dbEnabled()) {
    payload.kelly = {
      kellyMode: process.env.KELLY_MODE === "1",
      kellyLiveUse: process.env.KELLY_LIVE_USE === "1",
      kellyMultDefault: "0.5 (code default — the fraction-sweep sweet spot)",
      microCap: "10 (owner μ10 rule; sub-micro floors at 1)",
      note: "no DATABASE_URL — showing the static catalog + env state only",
    };
    return Response.json(payload);
  }

  const db = getDb();
  try {
    const runs = (await db`
      select id, run_at, script, cli, sha, family, gate, value, verdict, reasons, note, applied
      from promotion_runs order by run_at desc, id desc limit 200`) as unknown as Record<string, unknown>[];
    payload.runs = runs.map((r) => ({
      id: Number(r.id),
      run_at: String(r.run_at),
      script: String(r.script),
      cli: String(r.cli ?? ""),
      sha: String(r.sha ?? ""),
      family: String(r.family ?? ""),
      gate: String(r.gate ?? ""),
      value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
      verdict: r.verdict,
      reasons: typeof r.reasons === "string" ? JSON.parse(r.reasons) : (r.reasons ?? []),
      note: String(r.note ?? ""),
      applied: Boolean(r.applied),
    })) as PromotionRunRow[];

    const overrides = await db`
      select o.id, o.created_at, o.applied_at, o.family, o.gate, o.value, o.active, o.note, o.insight_id, i.title as insight_title
      from strategy_overrides o left join insights i on i.id = o.insight_id
      order by o.created_at desc limit 50`;
    payload.overrides = overrides.map((r) => ({
      id: Number(r.id),
      family: String(r.family),
      gate: String(r.gate),
      value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
      active: Boolean(r.active),
      note: String(r.note ?? ""),
      appliedAt: r.applied_at ? String(r.applied_at) : null,
      insightTitle: r.insight_title ? String(r.insight_title) : null,
    }));
  } catch (e) {
    payload.kelly = { error: String(e) };
    return Response.json(payload);
  }

  // re-map studies with the fresh runs
  payload.studies = studies.map((s) => {
    const st = statusFor(payload.runs, s.script);
    return {
      id: s.id,
      title: s.title,
      date: s.date,
      category: s.category,
      script: s.script,
      doc: s.doc,
      status: st.status,
      run: st.run,
    };
  });

  payload.kelly = {
    kellyMode: process.env.KELLY_MODE === "1",
    kellyLiveUse: process.env.KELLY_LIVE_USE === "1",
    kellyMultDefault: "0.5 (code default — the fraction-sweep sweet spot)",
    microCap: "10 (owner μ10 rule; sub-micro floors at 1)",
  };

  const withRuns = (payload.studies as { status: string }[]).filter((s) => s.status !== "research");
  payload.counts = {
    promoted: withRuns.filter((s) => s.status === "promoted").length,
    rejected: withRuns.filter((s) => s.status === "rejected").length,
    research: payload.studies.length - withRuns.length,
    activeOverrides: (payload.overrides as { active: boolean }[]).filter((o) => o.active).length,
    categories: CATEGORIES.length,
  } as unknown as Record<string, number>;
  payload.ok = true;
  return Response.json(payload);
}
