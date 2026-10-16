/* ------------------------------------------------------------------ *
 * SIGNAL-FREQUENCY SWEEP — scratch research input (uncommitted).
 *
 * Question: "too many 1-min legs go untraded — which gate relaxations
 * add signal count, and what do they cost in WR/PF/expR?"
 *
 * Levers measured per family, everything else frozen at the production
 * config (MOM_PROD / EXP_PROD / SOFT_PROD):
 *   momentum flush: breakFrac (0.75→0.70/0.65) · minGapBars (5→3) ·
 *                   breakWindow (10→15) · flushFrac (0.30→0.35) ·
 *                   failTolPts (0.5→1.0) · combos
 *   expansion:     minRangeR (1.6→1.4) · minAbsDeltaFrac (0.5→0.4) ·
 *                   minGapBars (5→3) · combos
 *   RTH soft:      minBuyFrac (0.60→0.55) · minClusters (3→2) ·
 *                   minRangeR (1.0→0.85) · minGapBars (5→3) · combos
 *
 * Scoring = the canonical engine scorer (pessimistic same-bar, 0.5 pt
 * round trip, 60-bar time exit, sequential one-trade-at-a-time per
 * family). RTH is scored on its research bracket (config target 0.75R,
 * market entry) — the live limit-entry replay is a separate question
 * already covered by rthQualityGateStudy/rthLimitValidation.
 *
 * Run from web/:
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/signalFrequencySweep.ts --offline [--max N]
 * ------------------------------------------------------------------ */

import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomConfig,
  type ExpansionConfig,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD, type SoftConfig } from "../lib/softMomentum";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { scoreTrade, scoreSequential } from "../lib/backtestEngine";

const COST_PTS = 0.5;
const HOLD_BARS = 60;
const CONCURRENCY = 8;

type Variant = {
  name: string;
  family: "mom" | "exp" | "rth";
  cfg: MomConfig | ExpansionConfig | SoftConfig;
};

const VARIANTS: Variant[] = [
  // ---- momentum flush — frequency levers (all from MOM_PROD) ----
  { name: "mom_prod", family: "mom", cfg: { ...MOM_PROD } },
  { name: "mom_bf70", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.7 } },
  { name: "mom_bf65", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.65 } },
  { name: "mom_gap3", family: "mom", cfg: { ...MOM_PROD, minGapBars: 3 } },
  { name: "mom_win15", family: "mom", cfg: { ...MOM_PROD, breakWindow: 15 } },
  { name: "mom_ff35", family: "mom", cfg: { ...MOM_PROD, flushFrac: 0.35 } },
  { name: "mom_tol1.0", family: "mom", cfg: { ...MOM_PROD, failTolPts: 1.0 } },
  { name: "mom_bf70_gap3", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.7, minGapBars: 3 } },
  { name: "mom_bf70_win15", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.7, breakWindow: 15 } },
  { name: "mom_bf70_gap3_win15", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.7, minGapBars: 3, breakWindow: 15 } },
  { name: "mom_bf72", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.72 } },
  { name: "mom_pick", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.7, breakWindow: 15, flushFrac: 0.35 } },
  { name: "mom_final", family: "mom", cfg: { ...MOM_PROD, breakFrac: 0.72, breakWindow: 15, flushFrac: 0.35 } },
  // ---- expansion — frequency levers (all from EXP_PROD) ----
  { name: "exp_prod", family: "exp", cfg: { ...EXP_PROD } },
  { name: "exp_rr1.4", family: "exp", cfg: { ...EXP_PROD, minRangeR: 1.4 } },
  { name: "exp_df0.4", family: "exp", cfg: { ...EXP_PROD, minAbsDeltaFrac: 0.4 } },
  { name: "exp_gap3", family: "exp", cfg: { ...EXP_PROD, minGapBars: 3 } },
  { name: "exp_rr1.4_df0.4", family: "exp", cfg: { ...EXP_PROD, minRangeR: 1.4, minAbsDeltaFrac: 0.4 } },
  { name: "exp_rr1.4_df0.4_gap3", family: "exp", cfg: { ...EXP_PROD, minRangeR: 1.4, minAbsDeltaFrac: 0.4, minGapBars: 3 } },
  { name: "exp_df0.45", family: "exp", cfg: { ...EXP_PROD, minAbsDeltaFrac: 0.45 } },
  { name: "exp_pick", family: "exp", cfg: { ...EXP_PROD, minRangeR: 1.4, minAbsDeltaFrac: 0.45 } },
  // ---- RTH soft — frequency levers (all from SOFT_PROD) ----
  { name: "rth_prod", family: "rth", cfg: { ...SOFT_PROD } },
  { name: "rth_bf55", family: "rth", cfg: { ...SOFT_PROD, minBuyFrac: 0.55 } },
  { name: "rth_cl2", family: "rth", cfg: { ...SOFT_PROD, minClusters: 2 } },
  { name: "rth_rr0.85", family: "rth", cfg: { ...SOFT_PROD, minRangeR: 0.85 } },
  { name: "rth_gap3", family: "rth", cfg: { ...SOFT_PROD, minGapBars: 3 } },
  { name: "rth_bf55_cl2_rr0.85_gap3", family: "rth", cfg: { ...SOFT_PROD, minBuyFrac: 0.55, minClusters: 2, minRangeR: 0.85, minGapBars: 3 } },
];

type Scored = MomentumSignal & { date: string; pnl: number; exit: number; hit: string; heldBars: number };

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string): Scored | null {
  const sc = scoreTrade(
    minutes,
    { dir: sig.dir === "long" ? 1 : -1, entry: sig.entry, stop: sig.stop, target: sig.target, entryIdx: sig.entryIdx, risk: sig.risk },
    { costPts: COST_PTS, holdBars: HOLD_BARS },
  );
  if (!sc) return null;
  return { ...sig, date, pnl: sc.pnl, exit: sc.exit, hit: sc.hit, heldBars: sc.heldBars };
}

function detect(v: Variant, minutes: MomMinute[]): MomentumSignal[] {
  if (v.family === "mom") return detectMomentum(minutes, v.cfg as MomConfig);
  if (v.family === "exp") return detectExpansionScalp(minutes, v.cfg as ExpansionConfig);
  return detectSoftMomentum(minutes, v.cfg as SoftConfig);
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const maxIdx = argv.indexOf("--max");
  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (maxIdx >= 0 && Number(argv[maxIdx + 1]) > 0) dates = dates.slice(0, Number(argv[maxIdx + 1]));
  console.log(`frequency sweep · ${dates.length} sessions · ${VARIANTS.length} variants\n`);

  const perVariant: Scored[][] = VARIANTS.map(() => []);
  let i = 0;
  let loaded = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const res = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of res) {
      if (!minutes) continue;
      loaded++;
      for (let v = 0; v < VARIANTS.length; v++) {
        const signals = detect(VARIANTS[v], minutes);
        perVariant[v].push(...scoreSequential(signals, (s) => scoreSignal(minutes, s, date)).filter(Boolean) as Scored[]);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const row = (t: Scored[]) => {
    const n = t.length;
    const wins = t.filter((x) => x.pnl > 0).length;
    const gw = t.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl, 0);
    const gl = Math.abs(t.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0));
    const net = t.reduce((a, x) => a + x.pnl, 0);
    return {
      n,
      perDay: n / loaded,
      wr: n ? (wins / n) * 100 : 0,
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
      avgPts: n ? net / n : 0,
      netPts: net,
      expR: n ? t.reduce((a, x) => a + x.pnl / x.risk, 0) / n : 0,
    };
  };

  const fams: { fam: string; rows: { v: Variant; r: ReturnType<typeof row> }[] }[] = [];
  for (const fam of ["mom", "exp", "rth"]) {
    const rows = VARIANTS.map((v, idx) => ({ v, r: row(perVariant[idx]) })).filter((x) => x.v.family === fam);
    fams.push({ fam, rows });
    console.log(`== ${fam.toUpperCase()} ==`);
    console.log(
      "variant".padEnd(22) + "n".padStart(6) + " /day".padStart(6) + " WR%".padStart(6) + " PF".padStart(6) + " avgPts".padStart(8) + " netPts".padStart(9) + " expR".padStart(6),
    );
    for (const { v, r } of rows) {
      console.log(
        v.name.padEnd(22) +
          String(r.n).padStart(6) +
          r.perDay.toFixed(1).padStart(6) +
          r.wr.toFixed(1).padStart(6) +
          (Number.isFinite(r.pf) ? r.pf.toFixed(2) : "  inf").padStart(6) +
          r.avgPts.toFixed(2).padStart(8) +
          r.netPts.toFixed(0).padStart(9) +
          r.expR.toFixed(2).padStart(6),
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
