import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Serve the overfitting-audit reports (written by gcdata/validate_sweep.py
 *  into web/data/validation) plus the trial ledger (exportSweep.ts). */
export async function GET() {
  const dir = path.join(process.cwd(), "data", "validation");
  const ledgerPath = path.join(dir, "trials.json");
  const diag: { cwd: string; dir: string; dirExists: boolean; files: string[] } = {
    cwd: process.cwd(),
    dir,
    dirExists: existsSync(dir),
    files: [],
  };
  try {
    if (diag.dirExists) {
      diag.files = readdirSync(dir).sort();
    }
    let reports: unknown[] = [];
    if (diag.dirExists) {
      reports = diag.files
        .filter((f) => f.endsWith(".validation.json"))
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
    return Response.json({ ok: true, version: 3, diag, reports, ledger });
  } catch (e) {
    return Response.json({ ok: false, status: "error", message: String(e), diag });
  }
}
