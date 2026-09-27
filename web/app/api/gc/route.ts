import type { NextRequest } from "next/server";
import {
  listDatasets,
  computeSheet,
  computeProfile,
  extractFootprint,
  analyze,
  type Session,
} from "@/lib/gcdata";

const SESSIONS: Session[] = ["RTH", "ETH"];

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const action = url.searchParams.get("action") ?? "datasets";
  const date = url.searchParams.get("date");
  const session = url.searchParams.get("session") as Session | null;
  const start = url.searchParams.get("start") ?? undefined;
  const end = url.searchParams.get("end") ?? undefined;
  const row = Number(url.searchParams.get("row") ?? 4);

  try {
    switch (action) {
      case "health": {
        // deployment diagnostic: what THIS container sees
        return Response.json({
          ok: true,
          buildId: "readthrough-v1",
          hasDbUrl: !!process.env.DATABASE_URL,
          dbUrlHost: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null,
          dataDir: process.env.GC_DATA_DIR ?? null,
          now: new Date().toISOString(),
        });
      }
      case "datasets": {
        return Response.json({ datasets: await listDatasets() });
      }
      case "sheet": {
        if (!date) return Response.json({ error: "missing date" }, { status: 400 });
        return Response.json({ sheet: await computeSheet(date) });
      }
      case "profile": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const p = await computeProfile(date, session, start, end, row);
        if (!p) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(p);
      }
      case "footprint": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const f = await extractFootprint(date, session, start, end);
        if (!f) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(f);
      }
      case "analysis": {
        if (!date || !session || !SESSIONS.includes(session))
          return Response.json({ error: "missing date/session" }, { status: 400 });
        const a = await analyze(date, session, start, end, row);
        if (!a) return Response.json({ error: "no data" }, { status: 404 });
        return Response.json(a);
      }
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
