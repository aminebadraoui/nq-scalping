import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Serve the latest offline threshold-sweep results (written by db/backtest.ts). */
export async function GET() {
  const file = path.join(process.cwd(), "..", "gcdata", "data", "backtest", "results.json");
  if (!existsSync(file)) {
    return Response.json({ ok: false, status: "pending", message: "backtest sweep has not been run yet" });
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Response.json({ ok: true, ...data });
  } catch (e) {
    return Response.json({ ok: false, status: "error", message: String(e) });
  }
}
