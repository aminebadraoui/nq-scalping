/* Headless evaluation of the oneSidedEntry filter on the reclaim signal.
 * Run with DATABASE_URL UNSET so the full JSON history (2.5y) is used, not the
 * recent-only Neon mirror:
 *   cd web && node --import ../scripts/ts-loader.mjs ./db/eval_onesided.ts
 */
import { buildLabSamples, evaluateTheory } from "../lib/lab";

const { samples, dates } = await buildLabSamples();
console.log(`samples=${samples.length}  sessions=${dates.length}`);

const base = evaluateTheory({ name: "baseline (all reclaims)", conditions: [] }, samples, dates);
const filt = evaluateTheory(
  { name: "oneSidedEntry == true", conditions: [{ feature: "oneSidedEntry", op: "==", value: true }] },
  samples,
  dates,
);
const filtFalse = evaluateTheory(
  { name: "oneSidedEntry == false", conditions: [{ feature: "oneSidedEntry", op: "==", value: false }] },
  samples,
  dates,
);

for (const r of [base, filt, filtFalse]) {
  console.log(`\n=== ${r.name} ===`);
  console.log(
    `  n=${r.all.n}  win=${r.all.wr.toFixed(1)}%  exp=${r.all.exp.toFixed(3)}R  ambiguous=${r.all.ambiguousShare.toFixed(0)}%`,
  );
  console.log(`  naive wilson [${r.all.wilson[0].toFixed(1)}, ${r.all.wilson[1].toFixed(1)}]  clustered [${r.all.clustered[0].toFixed(1)}, ${r.all.clustered[1].toFixed(1)}]`);
  console.log(`  daysAbove50=${r.all.daysAbove50}/${r.all.daysTotal}  trades/session=${r.all.tradesPerSession.toFixed(2)}`);
  if (r.holdout) console.log(`  holdout: train win=${r.holdout.train.wr.toFixed(1)}%  test win=${r.holdout.test.wr.toFixed(1)}%`);
  const w = r.warnings.filter((x) => !x.startsWith("Thresholds you pick"));
  for (const x of w) console.log(`  ⚠ ${x}`);
}
