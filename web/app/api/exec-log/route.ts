/* ------------------------------------------------------------------ *
 * /api/exec-log — the executor's own records (web/lib/execLog.ts
 * writes them; this route reads the latest 200 back for the journal).
 *
 * Read-only, display-only. The `meta` jsonb column is deliberately
 * NOT selected — it can carry order payloads, so it never leaves the
 * database. No secrets live in the selected columns.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "@/lib/gcdb";

export const dynamic = "force-dynamic";

type ExecLogRow = {
  ts: string;
  key: string;
  label: string;
  attempt: string;
  outcome: string;
  reason: string;
};

export async function GET() {
  if (!dbEnabled()) {
    return Response.json({ ok: true, rows: [], note: "db disabled" });
  }
  try {
    const rows = (await getDb()`
      select ts, key, label, attempt, outcome, reason
      from exec_log order by ts desc limit 200`) as ExecLogRow[];
    return Response.json({ ok: true, rows });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) });
  }
}
