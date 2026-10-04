/* Divergence-store backfill — the offline CLI that materialises the
 * per-session divergence artifacts the backtest engine consumes.
 *
 *   node --import scripts/ts-loader.mjs ./db/divStore.ts            # whole history
 *   node --import scripts/ts-loader.mjs ./db/divStore.ts --since 2026-09-01
 *   node --import scripts/ts-loader.mjs ./db/divStore.ts --session RTH
 *   node --import scripts/ts-loader.mjs ./db/divStore.ts --since … --skip-existing
 *
 * Idempotent (atomic rewrite per session). The nightly pipeline calls the
 * `--since` form so every newly collected day is stored the same night
 * (progressive storage of future data).
 */
import { backfillDivergences, DIVERGENCE_DIR } from "../lib/divStore";

const args = process.argv.slice(2);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (f: string) => args.includes(f);

const since = val("--since");
const session = val("--session") === "RTH" || val("--session") === "ETH" ? (val("--session") as "RTH" | "ETH") : undefined;
const skipExisting = flag("--skip-existing");

async function main() {
  const t0 = Date.now();
  const { written, failed } = await backfillDivergences({ since, session, skipExisting });
  const ms = Date.now() - t0;
  console.log(`divergence store → ${DIVERGENCE_DIR}`);
  console.log(`wrote ${written.length} session${written.length === 1 ? "" : "s"}${since ? ` (since ${since})` : ""}${session ? ` (${session})` : ""} in ${(ms / 1000).toFixed(1)}s`);
  for (const w of written.slice(0, 12)) console.log(`  ✓ ${w}`);
  if (written.length > 12) console.log(`  … ${written.length - 12} more`);
  for (const f of failed) console.error(`  ✗ ${f}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
