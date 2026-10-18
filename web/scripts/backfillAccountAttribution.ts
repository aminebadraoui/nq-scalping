/* ------------------------------------------------------------------ *
 * backfillAccountAttribution — stamp the account on every legacy row
 * so the DB itself is the ONE source of truth (no read-time guessing).
 *
 * What it does (idempotent, safe to re-run):
 *   1. adds `account_source` to trades, and `account` + `account_source`
 *      to manual_trades (reconcile_runs.account already exists);
 *   2. stamps 'fire-time' on trades rows that already carry an account
 *      (the nightly reconcile wrote them from the fill record);
 *   3. fills EMPTY accounts from the known switch timeline
 *      (deploy/STATE.md "Account history", lib/accountAttribution.ts):
 *        ≤ 2026-10-14  MFFUSFREOD706880008
 *        2026-10-15    MFFUEVREOD706880009
 *        ≥ 2026-10-16  DEMO2323960
 *   4. same for reconcile_runs (keyed on window_start's date) so the
 *      equity curve and ledger can be scoped per account.
 *
 * Usage (from web/):
 *   node --import scripts/ts-loader.mjs ./scripts/backfillAccountAttribution.ts
 *   node --import scripts/ts-loader.mjs ./scripts/backfillAccountAttribution.ts --dry-run
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { ACCOUNT_TIMELINE } from "../lib/accountAttribution";

const DRY = process.argv.includes("--dry-run");

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* no .env.local — env must be set by the caller */
  }
}
loadEnvLocal();

const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) {
  console.error("backfillAccountAttribution: need DATABASE_URL");
  process.exit(1);
}

const DDL = `
alter table trades add column if not exists account_source text not null default '';
alter table manual_trades add column if not exists account text not null default '';
alter table manual_trades add column if not exists account_source text not null default '';
`;

/** timeline windows as SQL fragments: [predicate, account] oldest first */
function timelineWins(): Array<{ pred: string; account: string }> {
  let prev: string | null = null;
  const out: Array<{ pred: string; account: string }> = [];
  for (const step of ACCOUNT_TIMELINE) {
    const until = step.untilDay === "9999-12-31" ? null : step.untilDay;
    const pred = until === null ? (prev ? `day > '${prev}'` : `day is not null`) : prev ? `day > '${prev}' and day <= '${until}'` : `day <= '${until}'`;
    out.push({ pred, account: step.account });
    if (until) prev = until;
  }
  return out;
}

async function main() {
  const sql = postgres(DB_URL, { max: 1 });
  await sql.unsafe(DDL);
  console.log(`DDL ok (dry-run: ${DRY})`);

  // 1. existing stamps → fire-time
  const stamped = await sql`
    select count(*)::int as n from trades where account <> '' and account_source = ''`;
  if (!DRY) {
    await sql`update trades set account_source = 'fire-time' where account <> '' and account_source = ''`;
  }
  console.log(`trades stamped fire-time: ${stamped[0].n}`);

  // 2. empty trades accounts → timeline
  for (const { pred, account } of timelineWins()) {
    const rows = await sql`
      select count(*)::int as n from trades
      where (account = '' or account is null) and ${sql.unsafe(pred)}`;
    if (!DRY && rows[0].n > 0) {
      await sql`
        update trades set account = ${account}, account_source = 'timeline'
        where (account = '' or account is null) and ${sql.unsafe(pred)}`;
    }
    console.log(`trades → ${account} (${pred}): ${rows[0].n}`);
  }

  // 3. manual_trades accounts → timeline (imports never carried an account)
  for (const { pred, account } of timelineWins()) {
    const rows = await sql`
      select count(*)::int as n from manual_trades
      where (account = '' or account is null) and ${sql.unsafe(pred)}`;
    if (!DRY && rows[0].n > 0) {
      await sql`
        update manual_trades set account = ${account}, account_source = 'timeline'
        where (account = '' or account is null) and ${sql.unsafe(pred)}`;
    }
    console.log(`manual_trades → ${account} (${pred}): ${rows[0].n}`);
  }

  // 4. reconcile_runs accounts → timeline (keyed on the run's window date)
  for (const { pred, account } of timelineWins()) {
    const runPred = pred.replaceAll("day", "(window_start at time zone 'UTC')::date::text");
    const rows = await sql`
      select count(*)::int as n from reconcile_runs
      where (account = '' or account is null) and ${sql.unsafe(runPred)}`;
    if (!DRY && rows[0].n > 0) {
      await sql`
        update reconcile_runs set account = ${account}
        where (account = '' or account is null) and ${sql.unsafe(runPred)}`;
    }
    console.log(`reconcile_runs → ${account} (${runPred}): ${rows[0].n}`);
  }

  // 5. summary
  const summary = (await sql`
    select
      (select count(*)::int from trades where account = '') as trades_empty,
      (select count(*)::int from manual_trades where account = '') as manual_empty,
      (select count(*)::int from reconcile_runs where account = '') as runs_empty`) as Array<Record<string, unknown>>;
  console.log(
    `\nremaining empty accounts — trades ${summary[0].trades_empty} · manual_trades ${summary[0].manual_empty} · reconcile_runs ${summary[0].runs_empty}`,
  );
  if (DRY) console.log("DRY RUN — nothing written");
  await sql.end();
}

main().catch((e) => {
  console.error("[backfillAccountAttribution] failed:", e);
  process.exit(1);
});
