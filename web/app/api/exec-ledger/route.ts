/* ------------------------------------------------------------------ *
 * /api/exec-ledger — the joined Signal → Execution view.
 *
 * One row per card: the Telegram signal record (Neon `signals`) joined
 * with the executor's live ledger (Neon `exec_trades`) + the exec log
 * (`exec_log`, one row per card key). Read-only, display-only — no
 * order payloads, no secrets, no mutation.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "@/lib/gcdb";
import { mergeExecLedger, type LedgerExec, type LedgerLog, type LedgerSignal } from "@/lib/execLedger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Math.min(400, Math.max(50, Number(new URL(req.url).searchParams.get("limit") ?? 300) || 300));

  if (!dbEnabled()) {
    return Response.json({ ok: false, error: "no DATABASE_URL", rows: [], summary: null });
  }
  try {
    const sql = getDb();
    const [sigRows, execRows, logRows] = await Promise.all([
      sql.unsafe<Array<Record<string, unknown>>>(
        `select key, ts, day, time_et, side, verdict, headline, sent, reason, outcome, entry, stop, target
         from signals order by ts desc limit ${limit}`,
      ),
      sql.unsafe<Array<Record<string, unknown>>>(
        `select key, signal_id, ts, day, time_et, label, family, side, contracts,
                sig_entry, sig_stop, sig_target, order_id, status, fill_entry, fill_entry_at,
                exit_avg, exit_fills, pts, gross_usd, fees_usd, net_usd, result
         from exec_trades order by ts desc limit ${limit}`,
      ),
      sql.unsafe<Array<Record<string, unknown>>>(
        `select key, outcome, reason from exec_log`,
      ),
    ]);

    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const signals: LedgerSignal[] = sigRows.map((r) => ({
      key: String(r.key ?? ""),
      ts: Number(r.ts ?? 0),
      day: String(r.day ?? ""),
      time_et: String(r.time_et ?? ""),
      side: String(r.side ?? ""),
      verdict: String(r.verdict ?? ""),
      headline: String(r.headline ?? ""),
      sent: r.sent === true || r.sent === "t" || r.sent === "true",
      reason: String(r.reason ?? ""),
      outcome: String(r.outcome ?? ""),
      entry: num(r.entry),
      stop: num(r.stop),
      target: num(r.target),
    }));
    const execs: LedgerExec[] = execRows.map((r) => ({
      key: String(r.key ?? ""),
      signal_id: String(r.signal_id ?? ""),
      ts: Number(r.ts ?? 0),
      day: String(r.day ?? ""),
      time_et: String(r.time_et ?? ""),
      label: String(r.label ?? ""),
      family: String(r.family ?? ""),
      side: String(r.side ?? ""),
      contracts: Number(r.contracts ?? 0),
      sig_entry: num(r.sig_entry),
      sig_stop: num(r.sig_stop),
      sig_target: num(r.sig_target),
      order_id: String(r.order_id ?? ""),
      status: String(r.status ?? ""),
      fill_entry: num(r.fill_entry),
      fill_entry_at: num(r.fill_entry_at),
      exit_avg: num(r.exit_avg),
      exit_fills: (r.exit_fills ?? null) as LedgerExec["exit_fills"],
      pts: num(r.pts),
      gross_usd: Number(r.gross_usd ?? 0),
      fees_usd: Number(r.fees_usd ?? 0),
      net_usd: Number(r.net_usd ?? 0),
      result: String(r.result ?? ""),
    }));
    const logs: LedgerLog[] = logRows.map((r) => ({
      key: String(r.key ?? ""),
      outcome: String(r.outcome ?? ""),
      reason: String(r.reason ?? ""),
    }));

    const { rows, summary } = mergeExecLedger(signals, execs, logs);
    return Response.json({
      ok: true,
      rows,
      summary,
      note: "live joined view — signal (Telegram) ∪ executor ledger; scripts/reconcileTrades.ts remains the nightly historical record",
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e), rows: [], summary: null });
  }
}
