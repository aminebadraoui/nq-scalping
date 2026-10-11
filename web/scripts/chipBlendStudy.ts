/* ------------------------------------------------------------------ *
 * Chip blend study — can the measured weak chips combine into ONE score?
 * (Medallion-ideas #3: "100 signals, each 0.02-correlated, blend to
 * ~0.2; one forecast per market".)
 *
 * Reads the recorded signal stream (Neon `signals`, decided rows) with
 * their feature vectors, fits a hand-rolled L2 logistic regression on
 * train (before 2026-01-01), and reports the TEST win rate by score
 * decile vs the best single chip and the baseline.
 *
 * Honesty footer is part of the output: if test n per decile < 80, the
 * decile read is labeled noise. This script never gates a live feed —
 * acceptance criteria live in docs/research/medallion-ideas-2026-10-07.md.
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/chipBlendStudy.ts
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "../lib/gcdb";
import { familyOf } from "../lib/tradeStats";

const CHIP_KEYS = [
  "esBroadConfirm",
  "esRsStretch",
  "seasonalFomcDay",
  "seasonalPreFomc",
  "seasonalHour37",
  "stopAtRound",
  "targetCrossRound",
  "gapInPath",
  "aPlus",
  "firstToday",
] as const;

type SigRow = { ts: string | number; day: string; verdict: string; outcome: string; features: unknown | null };

const chipOf = (v: unknown): number => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : 0);

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function fitLogistic(rows: { x: number[]; y: number }[], iters = 200, lr = 0.1, l2 = 0.01): number[] {
  const d = CHIP_KEYS.length + 1; // + bias
  const w = new Array<number>(d).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array<number>(d).fill(0);
    for (const r of rows) {
      const z = w[0] + r.x.reduce((acc, xi, i) => acc + w[i + 1] * xi, 0);
      const err = sigmoid(z) - r.y;
      g[0] += err;
      for (let i = 0; i < r.x.length; i++) g[i + 1] += err * r.x[i];
    }
    w[0] -= lr * (g[0] / rows.length);
    for (let i = 1; i < d; i++) w[i] = w[i] * (1 - lr * l2) - lr * (g[i] / rows.length);
  }
  return w;
}

const scoreOf = (w: number[], x: number[]): number => w[0] + x.reduce((acc, xi, i) => acc + w[i + 1] * xi, 0);

export async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.log("db disabled — the chip blend reads recorded features from Neon; run it where DATABASE_URL is set.");
    return;
  }
  const rows = (await getDb()`
    select ts, day, verdict, outcome, features from signals
    where outcome in ('win','loss') order by ts asc`) as SigRow[];

  const SPLIT = "2026-01-01";
  const data = rows
    .filter((r) => r.features && typeof r.features === "object")
    .map((r) => {
      const f = r.features as Record<string, unknown>;
      return {
        day: String(r.day),
        y: r.outcome === "win" ? 1 : 0,
        x: CHIP_KEYS.map((k) => chipOf(f[k])),
      };
    });
  const train = data.filter((r) => r.day < SPLIT);
  const test = data.filter((r) => r.day >= SPLIT);

  console.log("# Chip blend study — weak chips into one score\n");
  console.log(`rows: ${data.length} (train ${train.length} · test ${test.length} · split ${SPLIT})\n`);
  if (train.length < 200 || test.length < 200) {
    console.log("sample too thin for a blend read — nothing published beyond the per-chip table below");
  }

  // per-chip train/test WR for context
  console.log("| chip | train n | train WR | test n | test WR |");
  console.log("|---|---|---|---|---|");
  for (let i = 0; i < CHIP_KEYS.length; i++) {
    const tr = train.filter((r) => r.x[i] === 1);
    const te = test.filter((r) => r.x[i] === 1);
    const wr = (rows: { y: number }[]) => (rows.length ? rows.filter((r) => r.y === 1).length / rows.length : Number.NaN);
    console.log(
      `| ${CHIP_KEYS[i]} | ${tr.length} | ${tr.length ? (wr(tr) * 100).toFixed(1) + "%" : "—"} | ${te.length} | ${te.length ? (wr(te) * 100).toFixed(1) + "%" : "—"} |`,
    );
  }
  const baseTr = train.filter((r) => r.y === 1).length / train.length;
  const baseTe = test.filter((r) => r.y === 1).length / test.length;
  console.log(`| baseline (all) | ${train.length} | ${(baseTr * 100).toFixed(1)}% | ${test.length} | ${(baseTe * 100).toFixed(1)}% |\n`);

  if (train.length >= 200 && test.length >= 200) {
    const w = fitLogistic(train);
    const scored = test.map((r) => ({ ...r, s: scoreOf(w, r.x) })).sort((a, b) => b.s - a.s);
    const dec = Math.floor(scored.length / 10);
    console.log("| test decile (by blend score) | n | WR |");
    console.log("|---|---|---|");
    for (let i = 0; i < 10; i++) {
      const slice = scored.slice(i * dec, i === 9 ? scored.length : (i + 1) * dec);
      const wins = slice.filter((r) => r.y === 1).length;
      const thin = slice.length < 80 ? " (n<80 — noise)" : "";
      console.log(`| ${i + 1}${i === 0 ? " (top)" : i === 9 ? " (bottom)" : ""} | ${slice.length} | ${((wins / slice.length) * 100).toFixed(1)}%${thin} |`);
    }
    console.log("\nAcceptance (pre-registered, medallion-ideas #3): the blend matters only if the top decile beats");
    console.log("BOTH the baseline and the best single chip on out-of-sample WR with n ≥ ~80 per decile —");
    console.log("otherwise the chips remain labels (multiple testing is the null here).");
  }

  // best single chip on test, for the acceptance comparison
  let bestChip = "";
  let bestWr = -1;
  for (let i = 0; i < CHIP_KEYS.length; i++) {
    const te = test.filter((r) => r.x[i] === 1);
    if (te.length >= 80) {
      const wr = te.filter((r) => r.y === 1).length / te.length;
      if (wr > bestWr) {
        bestWr = wr;
        bestChip = CHIP_KEYS[i];
      }
    }
  }
  console.log(`\nbest single chip on test: ${bestChip || "none with n≥80"}${bestChip ? ` (${(bestWr * 100).toFixed(1)}%, n=${test.filter((r) => r.x[CHIP_KEYS.indexOf(bestChip as (typeof CHIP_KEYS)[number])] === 1).length})` : ""}`);
  console.log("family filter: all families pooled — a per-family blend is the follow-up if this passes.");
}

main().catch((e) => {
  console.error("chipBlendStudy failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
