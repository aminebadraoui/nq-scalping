import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Serve the overfitting-audit reports (written by gcdata/validate_sweep.py)
 *  plus the trial ledger (written by web/scripts/exportSweep.ts). */
export async function GET() {
  const dir = path.join(process.cwd(), "..", "gcdata", "data", "sweeps");
  const ledgerPath = path.join(process.cwd(), "..", "gcdata", "data", "trials.json");
  try {
    let reports: unknown[] = [];
    if (existsSync(dir)) {
      reports = readdirSync(dir)
        .filter((f) => f.endsWith(".validation.json"))
        .sort()
        .reverse()
        .map((f) => {
          try {
            return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
    let ledger: unknown = { entries: [] };
    if (existsSync(ledgerPath)) {
      try {
        ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      } catch {
        /* stale ledger — treat as empty */
      }
    }
    return Response.json({ ok: true, reports, ledger });
  } catch (e) {
    return Response.json({ ok: false, status: "error", message: String(e) });
  }
}
