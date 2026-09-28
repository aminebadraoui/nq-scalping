import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Serve the latest offline threshold-sweep results (written by db/backtest.ts),
 *  per session window: ?session=rth (default) or ?session=eth. */
export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session") === "eth" ? "eth" : "rth";
  const dir = path.join(process.cwd(), "..", "gcdata", "data", "backtest");
  const file = path.join(dir, `results_${session}.json`);
  const legacy = path.join(dir, "results.json");

  // the legacy file was RTH-only; only fall back to it for the rth query
  const pick = existsSync(file) ? file : session === "rth" && existsSync(legacy) ? legacy : null;
  if (!pick) {
    return Response.json({ ok: false, status: "pending", session, message: "backtest sweep has not been run yet" });
  }
  try {
    const data = JSON.parse(readFileSync(pick, "utf8"));
    return Response.json({ ok: true, ...data });
  } catch (e) {
    return Response.json({ ok: false, status: "error", message: String(e) });
  }
}
