import { listDaybookDaysRemote, readDaybookDayRemote, type DaybookRecord } from "@/lib/daybook";

export const dynamic = "force-dynamic";

/**
 * The daybook API — the DB-less system journal (lib/daybook.ts).
 *
 *   GET /api/daybook                  → variation index: per trading day,
 *                                        the boot fingerprint (variationId +
 *                                        git SHA), record counts, and the
 *                                        consolidated summaries (local
 *                                        volume ∪ R2 archive).
 *   GET /api/daybook?day=YYYY-MM-DD   → that day's records as JSON.
 *   GET /api/daybook?day=…&format=jsonl
 *                                     → raw JSONL (the nightly consolidation
 *                                       pulls this to append day-end rows).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const day = url.searchParams.get("day");
    const format = url.searchParams.get("format") ?? "json";

    if (!day) {
      const dayKeys = await listDaybookDaysRemote();
      const days = await Promise.all(
        dayKeys.map(async (d) => {
          const rows = await readDaybookDayRemote(d);
          const boots = rows.filter((r) => r.t === "boot");
          const boot = boots.length ? (boots[boots.length - 1] as Extract<DaybookRecord, { t: "boot" }>) : null;
          const summaries = rows.filter((r) => r.t === "dayend").map((r) => (r as Extract<DaybookRecord, { t: "dayend" }>).summary);
          return {
            day: d,
            variationId: boot?.variationId ?? null,
            sha: boot?.sha ?? "",
            records: rows.length,
            summaries,
          };
        }),
      );
      return Response.json({ ok: true, days });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return Response.json({ ok: false, reason: "day must be YYYY-MM-DD" }, { status: 400 });
    }
    const rows = await readDaybookDayRemote(day);
    if (format === "jsonl") {
      const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
      return new Response(text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json({ ok: true, day, records: rows });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) }, { status: 500 });
  }
}
