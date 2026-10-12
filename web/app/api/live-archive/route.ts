import { getLiveArchive } from "@/lib/liveArchiveServer";

export const dynamic = "force-dynamic";

/**
 * The live archive — every strategy family's realized fills, aggregated
 * from the daybook's nightly-consolidated day summaries (local volume ∪
 * R2 archive), refreshed once a day by the nightly pipeline.
 *
 *   GET /api/live-archive → { ok, lastDay, sessions, families[] }
 *
 * Served to the client surfaces (/backtest's live panel); server
 * components read the same data through lib/liveArchiveServer.ts.
 */
export async function GET() {
  try {
    const archive = await getLiveArchive();
    return Response.json({ ok: true, ...archive });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) }, { status: 500 });
  }
}
