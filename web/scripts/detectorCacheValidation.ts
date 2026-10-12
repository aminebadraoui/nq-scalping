/* ------------------------------------------------------------------ *
 * Detector-cache equivalence validation — the backtest evidence for
 * the live memoization (lib/detectorCache.ts).
 *
 * This is an EQUIVALENCE check, not an edge study: for every archived
 * session it asserts that the memoized detector output is bit-identical
 * to a fresh computation, that a stable key returns the same object
 * reference, and that a bars-revision bump invalidates the cache.
 * The cache can therefore never change a live trading decision — it
 * only skips recomputation of unchanged work.
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/detectorCacheValidation.ts [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import {
  detectMomentumMemo,
  detectExpansionScalpMemo,
  detectSoftMomentumMemo,
  detectOpenDriveMemo,
  cachedFootprint,
} from "../lib/detectorCache";
import type { FootprintMinute } from "../lib/gcdata";
import type { LiveMinute } from "../lib/live";

async function main(): Promise<void> {
  const max = Number(process.env.DCV_MAX ?? "30");
  const dates = await archiveDates({ source: "manifest" });
  if (!dates.length) {
    console.log("detectorCacheValidation FAIL — no archive sessions available");
    process.exit(1);
  }
  const sample = dates.slice(-max);
  let sessions = 0;
  let comparisons = 0;
  let fails = 0;

  for (const date of sample) {
    const mins = await loadSessionMinutes(date);
    if (!mins || mins.length < 60) continue;
    const fp = mins as unknown as FootprintMinute[];
    sessions++;

    const cases: Array<{ name: string; memo: (rev: number) => unknown; fresh: () => unknown }> = [
      { name: "momentum", memo: (rev) => detectMomentumMemo(fp, MOM_PROD, rev), fresh: () => detectMomentum(fp, MOM_PROD) },
      { name: "expansion", memo: (rev) => detectExpansionScalpMemo(fp, EXP_PROD, rev), fresh: () => detectExpansionScalp(fp, EXP_PROD) },
      { name: "softMomentum", memo: (rev) => detectSoftMomentumMemo(fp, SOFT_PROD, rev), fresh: () => detectSoftMomentum(fp, SOFT_PROD) },
      { name: "openDrive", memo: (rev) => detectOpenDriveMemo(fp, OPEN_PROD, rev), fresh: () => detectOpenDrive(fp, OPEN_PROD) },
    ];

    for (const c of cases) {
      comparisons++;
      const memoJson = JSON.stringify(c.memo(0));
      const freshJson = JSON.stringify(c.fresh());
      if (memoJson !== freshJson) {
        fails++;
        console.log(`MISMATCH ${date} ${c.name} — memoized ≠ fresh`);
      }
      const r1 = c.memo(0);
      const r2 = c.memo(0);
      if (r1 !== r2) {
        fails++;
        console.log(`REF ${date} ${c.name} — stable key returned a new object`);
      }
      const r3 = c.memo(999_999); // revision bump must invalidate
      if (r3 === r1) {
        fails++;
        console.log(`REVISION ${date} ${c.name} — revision bump did not invalidate`);
      } else if (JSON.stringify(r3) !== freshJson) {
        fails++;
        console.log(`REVISION-MISMATCH ${date} ${c.name} — recomputed output drifted`);
      }
    }

    // the footprint conversion cache: same buffer + revision → same array
    const liveMins: LiveMinute[] = mins.map((m) => ({
      t: m.t,
      du: m.d,
      o: m.o,
      h: m.high,
      l: m.low,
      c: m.c,
      vol: m.buy + m.sell,
      buy: m.buy,
      sell: m.sell,
      live: true,
      source: "candle",
    }));
    const f1 = cachedFootprint(liveMins, 0);
    const f2 = cachedFootprint(liveMins, 0);
    if (f1 !== f2) {
      fails++;
      console.log(`FP-REF ${date} — conversion cache returned a new array on a stable key`);
    }
    const f3 = cachedFootprint(liveMins, 1);
    if (f3 === f1) {
      fails++;
      console.log(`FP-REVISION ${date} — conversion cache survived a revision bump`);
    }
  }

  console.log(
    `detectorCacheValidation: ${sessions} sessions · ${comparisons} detector comparisons · fails ${fails} → ${fails ? "FAIL" : "PASS"}`,
  );
  process.exit(fails ? 1 : 0);
}

void main();
