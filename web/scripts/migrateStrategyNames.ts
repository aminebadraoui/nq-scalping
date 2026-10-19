/* ------------------------------------------------------------------ *
 * Strategy-name migration — 2026-10-19 rename (ids → expressive names).
 *
 * Idempotent, single-writer, safe to re-run: every UPDATE uses a
 * legacy→canonical CASE, so rows already migrated are untouched.
 * Run from web/ with DATABASE_URL set:
 *
 *   node --import tests/ts-loader.mjs ./scripts/migrateStrategyNames.ts
 *
 * Does NOT touch: signals.verdict/headline text (historical prose is
 * parsed by alias-aware code), exec_trades.label (the leading-token
 * parser accepts old + new), weekly_experiments.args (the study CLI
 * canonicalizes --family at run time), weekly_reviews.stats snapshots
 * (historical analytics — display resolves via FAMILY_LABEL).
 * ------------------------------------------------------------------ */

import postgres from "postgres";

const ALIASES: Record<string, string> = {
  momentum_flush: "failed_flush_breakout",
  momentum_expansion: "huge_bar_expansion",
  rth: "session_continuation",
  reversal: "lvn_reversal",
};

const CASE_EXPR = (col: string): string =>
  Object.entries(ALIASES)
    .map(([legacy, canon]) => `when ${col} = '${legacy}' then '${canon}'`)
    .join(" ") + ` else ${col} end`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set — aborting (nothing changed).");
    process.exit(1);
  }
  const sql = postgres(url, { ssl: "require", max: 1 });
  const changed = async (q: string): Promise<number> => {
    const rows = (await sql.unsafe(q)) as Array<{ n: number }>;
    return rows.length ? Number(rows[0].n) : 0;
  };

  console.log("# Strategy-name migration — 2026-10-19 rename\n");
  console.log("before:");
  const before = await sql`select family, count(*) n from strategy_overrides group by family union all select family, count(*) from exec_trades group by family`;
  console.log("  strategy_overrides/exec_trades families:", before.map((r) => `${r.family}(${r.n})`).join(" "));

  const results: Array<[string, number]> = [];

  results.push(["strategy_overrides.family", await changed(`update strategy_overrides set family = ${CASE_EXPR("family")} where family in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  results.push(["trades.family", await changed(`update trades set family = ${CASE_EXPR("family")} where family in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  results.push(["exec_trades.family", await changed(`update exec_trades set family = ${CASE_EXPR("family")} where family in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  results.push(["pattern_runs.family", await changed(`update pattern_runs set family = ${CASE_EXPR("family")} where family in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  results.push(["promotion_runs.family", await changed(`update promotion_runs set family = ${CASE_EXPR("family")} where family in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  results.push(["insights.strategy", await changed(`update insights set strategy = ${CASE_EXPR("strategy")} where strategy in (${Object.keys(ALIASES).map((k) => `'${k}'`).join(",")}) returning count(*) n`)]);

  // signals.features jsonb: the feed stamps the family under BOTH keys —
  // `family` (momentum / session-continuation cards) and `kind` (open cards).
  for (const key of ["family", "kind"]) {
    for (const [legacy, canon] of Object.entries(ALIASES)) {
      const n = await changed(
        `update signals set features = jsonb_set(features, '{${key}}', '"${canon}"'::jsonb)
         where features->>'${key}' = '${legacy}' returning count(*) n`,
      );
      if (n > 0) results.push([`signals.features->>${key} (${legacy}→${canon})`, n]);
    }
  }

  console.log("\nmigrated:");
  for (const [what, n] of results) console.log(`  ${n} rows · ${what}`);

  console.log("\nafter:");
  const after = await sql`select family, count(*) n from strategy_overrides group by family union all select family, count(*) from exec_trades group by family`;
  console.log("  strategy_overrides/exec_trades families:", after.map((r) => `${r.family}(${r.n})`).join(" "));

  await sql.end();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error("migration failed:", e);
  process.exit(1);
});
