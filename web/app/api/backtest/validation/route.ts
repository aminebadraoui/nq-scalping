import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

/* Bundled snapshot: the reports are committed inside this route's folder so
 * they ship INSIDE the server bundle — the deployment mechanism that
 * provably delivers fresh code (the deployed image does not carry /app/data,
 * see commit 62c9cad). New reports = new commit = new bundle. */
import momentumReport from "./reports/momentum-2026-10-04T00-44.validation.json";
import rthReport from "./reports/rth-2026-10-04T00-46.validation.json";
import expansionReport from "./reports/expansion-2026-10-04T01-41.validation.json";
import trialsSnapshot from "./reports/trials.json";

export const dynamic = "force-dynamic";

const BUNDLED: unknown[] = [expansionReport, rthReport, momentumReport]; // newest first

/** Serve the overfitting-audit reports + trial ledger. On the Mac lab the
 *  validator writes into this same folder, so fresh files win over the
 *  bundled snapshot; everywhere else the bundle is the source of truth. */
export async function GET() {
  const dir = path.join(process.cwd(), "app", "api", "backtest", "validation", "reports");
  const ledgerPath = path.join(dir, "trials.json");

  let source: "fs" | "bundled" = "bundled";
  let reports: unknown[] = BUNDLED;
  let ledger: unknown = trialsSnapshot;

  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".validation.json")).sort().reverse();
    if (files.length > 0) {
      const parsed = files
        .map((f) => {
          try {
            return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (parsed.length > 0) {
        reports = parsed;
        source = "fs";
      }
    }
    if (existsSync(ledgerPath)) {
      try {
        ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      } catch {
        /* keep the bundled snapshot */
      }
    }
  }

  return Response.json({ ok: true, version: 5, source, reports, ledger });
}
