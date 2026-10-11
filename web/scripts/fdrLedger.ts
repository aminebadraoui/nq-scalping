/* ------------------------------------------------------------------ *
 * FDR ledger — the false-discovery accounting for every hypothesis this
 * repo has tested (Medallion-ideas #7, "the Patterson defense applied to
 * our own repo", docs/research/medallion-ideas-2026-10-07.md).
 *
 * Pure data: reads the committed study catalog (lib/studies.ts) — no DB.
 * Output: per-category study counts, expected false discoveries at
 * α = 0.01 / 0.05, and the Bonferroni bar any FUTURE gate proposal must
 * clear: p < α / (total studies).
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/fdrLedger.ts
 * ------------------------------------------------------------------ */

import { studies, CATEGORIES } from "../lib/studies";

function fmt(n: number, dp = 1): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function main(): void {
  const n = studies.length;
  const byCat = new Map<string, number>();
  for (const s of studies) byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);

  console.log("# False-discovery ledger — the repo's tested hypotheses\n");
  console.log(`total studies in the committed catalog: ${n}\n`);
  console.log("| category | studies | E[false discoveries] @ α=1% | @ α=5% |");
  console.log("|---|---|---|---|");
  for (const c of CATEGORIES) {
    const k = byCat.get(c.id) ?? 0;
    if (k === 0) continue;
    console.log(`| ${c.id} (${c.label}) | ${k} | ${fmt(k * 0.01)} | ${fmt(k * 0.05)} |`);
  }
  console.log(`| **total** | **${n}** | **${fmt(n * 0.01)}** | **${fmt(n * 0.05)}** |\n`);

  const bonf = 0.01 / n;
  console.log(`Bonferroni bar for any FUTURE gate proposal: p < 0.01 / ${n} = ${fmt(bonf, 5)}`);
  console.log(`(a proposal whose study does not beat this bar is expected-noise under multiple testing —\n`);
  console.log(` the pre-registration + train/test split in docs/BACKTEST-REPORT-STANDARD.md remains mandatory.)`);
}

main();
