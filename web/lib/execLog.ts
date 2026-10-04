/* ------------------------------------------------------------------ *
 * Execution log — every order-place attempt and watcher decision,
 * persisted best-effort to Neon so container restarts can never
 * destroy the evidence again (the 12:18 and 12:39 investigations both
 * died on the lost stdout of the replaced container).
 *
 * Rows are small and append-only; the table is created lazily on the
 * first write. Query it after any execution mystery:
 *   select * from exec_log order by ts desc limit 20;
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";

const TABLE_SQL = `
create table if not exists exec_log (
  id bigint generated always as identity primary key,
  ts bigint not null,
  key text not null,
  label text not null,
  attempt text not null,
  outcome text not null,
  reason text not null default '',
  meta jsonb
);
create index if not exists exec_log_ts_idx on exec_log (ts desc);
`;

let ready = false;

export type ExecLogEntry = {
  key: string;
  label: string;
  attempt: "initial" | "resend" | "watch";
  outcome:
    | "ok"
    | "failed"
    | "no_fill"
    | "verified_absent"
    | "unresolved"
    | "skipped_stale"
    | "deferred_blackout"
    | "resend_ok"
    | "resend_failed"
    | "resend_failed_retrying"
    | "resend_gave_up"
    | "resend_aborted";
  reason: string;
  meta?: Record<string, unknown>;
};

export async function logExec(e: ExecLogEntry): Promise<void> {
  if (!dbEnabled()) return;
  if (!ready) {
    try {
      await getDb().unsafe(TABLE_SQL);
      ready = true;
    } catch {
      return;
    }
  }
  try {
    await getDb()`
      insert into exec_log (ts, key, label, attempt, outcome, reason, meta)
      values (${Date.now()}, ${e.key}, ${e.label}, ${e.attempt}, ${e.outcome}, ${e.reason}, ${
        e.meta ? JSON.stringify(e.meta) : null
      })`;
  } catch {
    /* best-effort — never block execution on the log */
  }
}
