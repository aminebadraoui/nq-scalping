/* ------------------------------------------------------------------ *
 * Breadth audit — Medallion breadth accounting (medallion-ideas #1):
 * IR = IC × √N needs INDEPENDENT bets. This script measures how many
 * effective independent bets each family really made, from the recorded
 * signal outcomes (Neon `signals`, decided rows only).
 *
 * For each family: n, WR, Wilson 95% CI, lag-1/2/3 autocorrelation of
 * win/loss WITHIN days (no cross-day coupling), variance-inflation
 * factor VIF ≈ 1 + 2·(ρ1+ρ2+ρ3) (clamped ≥ 1), effective N = n / VIF,
 * and the trading days needed for the lower CI to clear 50% at 95%.
 *
 * DB-off: prints a note and exits 0 (research runs on the Mac against
 * the archive; this audit reads the recorded decision stream).
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/breadthAudit.ts
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "../lib/gcdb";
import { familyOf } from "../lib/tradeStats";

type SigRow = { ts: string | number; day: string; verdict: string; outcome: string; features: unknown | null };

function familyOfRow(r: SigRow): string {
  const f = r.features as { family?: unknown } | null;
  if (f && typeof f.family === "string" && f.family) return f.family;
  return familyOf(r.verdict);
}

function wilson95(n: number, wins: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, (centre - half) / denom), hi: Math.min(1, (centre + half) / denom) };
}

export async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.log("db disabled — the breadth audit reads the recorded signal stream from Neon; run it where DATABASE_URL is set.");
    return;
  }
  const rows = (await getDb()`
    select ts, day, verdict, outcome, features from signals
    where outcome in ('win','loss') order by ts asc`) as SigRow[];

  const byFamily = new Map<string, { day: string; win: number }[]>();
  for (const r of rows) {
    const fam = familyOfRow(r);
    const e = byFamily.get(fam) ?? [];
    e.push({ day: String(r.day), win: r.outcome === "win" ? 1 : 0 });
    byFamily.set(fam, e);
  }

  console.log("# Breadth audit — how many INDEPENDENT bets is each family really making?\n");
  console.log("| family | n | WR | CI95 | ρ1 | ρ2 | ρ3 | VIF | effective N | trades/day | days to prove @95% | verdict |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");

  for (const [fam, seq] of [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const n = seq.length;
    if (n < 50) continue;
    const wins = seq.filter((s) => s.win === 1).length;
    const wr = wins / n;

    // lag-k autocorrelation of the win/loss sequence, same-day pairs only
    const lag = (k: number): number => {
      let sum = 0;
      let cnt = 0;
      for (let i = 0; i + k < n; i++) {
        if (seq[i].day !== seq[i + k].day) continue;
        sum += (seq[i].win - wr) * (seq[i + k].win - wr);
        cnt++;
      }
      const denomSum = seq.reduce((acc, s) => acc + (s.win - wr) * (s.win - wr), 0);
      if (cnt === 0 || denomSum === 0) return 0;
      return sum / denomSum / (cnt / n);
    };
    const r1 = lag(1);
    const r2 = lag(2);
    const r3 = lag(3);
    const vif = Math.max(1, 1 + 2 * (r1 + r2 + r3));
    const effN = n / vif;

    const days = new Set(seq.map((s) => s.day)).size;
    const tpd = days > 0 ? n / days : 0;
    const { lo } = wilson95(Math.round(effN), Math.round(wins / vif));
    // lower Wilson bound clears 50% → the edge is real at 95% at this breadth
    const proven = lo > 0.5;
    // days needed for the LOWER bound to clear 50% (SE shrinks with effective N)
    const p = wr;
    const z = 1.96;
    const nNeeded = p > 0.5 ? (z * z * p * (1 - p)) / ((p - 0.5) * (p - 0.5)) : Infinity;
    const daysNeeded = tpd > 0 && Number.isFinite(nNeeded) ? Math.ceil((nNeeded * vif) / tpd) : Infinity;

    console.log(
      `| ${fam} | ${n} | ${(wr * 100).toFixed(1)}% | [${(wilson95(n, wins).lo * 100).toFixed(1)}–${(wilson95(n, wins).hi * 100).toFixed(1)}] | ` +
        `${r1.toFixed(2)} | ${r2.toFixed(2)} | ${r3.toFixed(2)} | ${vif.toFixed(2)} | ${Math.round(effN)} | ` +
        `${tpd.toFixed(1)} | ${Number.isFinite(daysNeeded) ? daysNeeded : "—"} | ` +
        `${proven ? "**edge real at 95%**" : "not distinguishable from noise at 95%"} |`,
    );
  }
  console.log("\nHonest reading: WR/PF on the raw n OVERSTATE confidence when same-day trades are correlated.");
  console.log("The effective N is the number Medallion's IR = IC × √N arithmetic actually runs on.");
}

main().catch((e) => {
  console.error("breadthAudit failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
