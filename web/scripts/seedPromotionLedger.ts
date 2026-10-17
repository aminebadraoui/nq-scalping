/* ------------------------------------------------------------------ *
 * Seed promotion ledger — backfills the promotion_runs table with the
 * historical contract verdicts (lib/promotionLedger.ts HISTORICAL_RUNS)
 * so the /promotions surface is accurate from day one. Idempotent: a
 * (script, gate, sha) triple that already exists is skipped.
 *
 *   cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/seedPromotionLedger.ts
 * ------------------------------------------------------------------ */

import postgres from "postgres";
import { HISTORICAL_RUNS } from "../lib/promotionLedger";

async function main(): Promise<void> {
  const DB_URL = process.env.DATABASE_URL;
  if (!DB_URL) {
    console.error("seedPromotionLedger: DATABASE_URL is not set");
    process.exit(1);
  }
  const sql = postgres(DB_URL, { ssl: "require", max: 1 });
  try {
    await sql`
      create table if not exists promotion_runs (
        id bigint generated always as identity primary key,
        run_at timestamptz not null default now(),
        script text not null,
        cli text not null default '',
        sha text not null default '',
        family text not null default '',
        gate text not null default '',
        value jsonb,
        verdict text not null check (verdict in ('passed', 'rejected')),
        reasons jsonb not null default '[]',
        note text not null default '',
        applied boolean not null default false
      )`;
    let inserted = 0;
    for (const r of HISTORICAL_RUNS) {
      const existing = await sql`
        select id from promotion_runs where script = ${r.script} and gate = ${r.gate} and sha = ${r.sha} limit 1`;
      if (existing.length > 0) {
        console.log(`skip ${r.script} · ${r.gate} (already seeded)`);
        continue;
      }
      await sql`
        insert into promotion_runs (script, cli, sha, family, gate, value, verdict, reasons, note, applied)
        values (${r.script}, ${r.cli}, ${r.sha}, ${r.family}, ${r.gate},
                ${r.value === null ? null : JSON.stringify(r.value)}::jsonb,
                ${r.verdict}, ${JSON.stringify(r.reasons)}::jsonb, ${r.note}, ${r.applied})`;
      inserted++;
      console.log(`seeded ${r.script} · ${r.gate} → ${r.verdict}`);
    }
    console.log(`done: ${inserted} inserted, ${HISTORICAL_RUNS.length - inserted} skipped`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
