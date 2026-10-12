/* ------------------------------------------------------------------ *
 * /api/exec-latency — the execution tab's timing view (display-only).
 *
 *   · live  — the in-memory registry (lib/execLatency.ts): the cycle
 *             running right now, the latest finished one, the rolling
 *             window, and the submit→fill legs
 *   · rows  — the persisted history from Neon (latest 500, all kinds)
 *   · agg   — p50/p95 per stage over the last hour and 24h
 *   · trend — average cycle total per UTC day, last 30 days
 *
 * Read-only; no secrets; nothing here can change execution.
 * ------------------------------------------------------------------ */

import { latencySnapshot, stageAggregates, pct, ensureLatencyTable, type CycleRecord } from "@/lib/execLatency";
import { dbEnabled, getDb } from "@/lib/gcdb";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type Row = {
  ts: number;
  kind: string;
  total_ms: number;
  stages: Record<string, number>;
  detail: Record<string, unknown>;
};

export async function GET(req: NextRequest) {
  const live = latencySnapshot();
  const out: Record<string, unknown> = { ok: true, live };
  // ?lite=1 — the 5s live poll: in-memory snapshot only, no DB reads
  if (req.nextUrl.searchParams.get("lite") === "1") {
    return Response.json(out);
  }
  if (!dbEnabled()) {
    return Response.json({ ...out, rows: [], agg: {}, trend: [], note: "db disabled — history unavailable, live view only" });
  }
  try {
    // lazy-create so a fresh database reads as empty history, not an error
    await ensureLatencyTable();
    const rows = (await getDb().unsafe(
      "select ts, kind, total_ms, stages, detail from exec_latency order by ts desc limit 500",
    )) as Row[];
    // postgres.js .unsafe() returns bigint and jsonb columns as STRINGS —
    // normalize so the client gets numbers and objects
    const norm = (v: unknown): Record<string, number> => {
      if (v && typeof v === "object") return v as Record<string, number>;
      if (typeof v === "string") {
        try {
          return JSON.parse(v) as Record<string, number>;
        } catch {
          return {};
        }
      }
      return {};
    };
    const normDetail = (v: unknown): Record<string, unknown> => {
      if (v && typeof v === "object") return v as Record<string, unknown>;
      if (typeof v === "string") {
        try {
          return JSON.parse(v) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      return {};
    };
    const cycles: CycleRecord[] = [];
    for (const r of rows) {
      r.ts = Number(r.ts);
      r.stages = norm(r.stages);
      r.detail = normDetail(r.detail);
      if (r.kind !== "cycle") continue;
      cycles.push({
        id: "",
        ts: r.ts,
        kind: "cycle",
        totalMs: Number(r.total_ms),
        stages: r.stages,
        detail: r.detail as CycleRecord["detail"],
      });
    }
    const now = Date.now();
    const h1 = cycles.filter((c) => now - c.ts < 3600_000);
    const h24 = cycles.filter((c) => now - c.ts < 24 * 3600_000);
    const barAgeStats = (list: number[]) => ({ p50: pct(list, 50), p95: pct(list, 95), n: list.length });
    const barAgesOf = (cs: CycleRecord[]) =>
      cs.map((c) => c.detail.barAgeMs).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const trendRows = (await getDb().unsafe(
      `select (ts / 86400000)::bigint as day,
              count(*) as n,
              avg(total_ms)::float8 as avg_ms,
              avg((detail->>'barAgeMs')::float8) as avg_barage
       from exec_latency
       where kind = 'cycle' and ts > ${now - 30 * 86400_000}
       group by 1 order by 1`,
    )) as Array<{ day: number; n: number; avg_ms: number; avg_barage: number | null }>;
    return Response.json({
      ...out,
      rows,
      agg: {
        h1: stageAggregates(h1),
        h24: stageAggregates(h24),
        barAge: { h1: barAgeStats(barAgesOf(h1)), h24: barAgeStats(barAgesOf(h24)) },
      },
      trend: trendRows.map((t) => ({
        day: Number(t.day) * 86400_000,
        n: Number(t.n),
        avgMs: Math.round(Number(t.avg_ms)),
        avgBarAge: t.avg_barage === null ? null : Math.round(Number(t.avg_barage)),
      })),
    });
  } catch (e) {
    return Response.json({ ...out, ok: false, error: String(e), rows: [], agg: {}, trend: [] });
  }
}
