/* ------------------------------------------------------------------ *
 * Conviction-tier sizing study (Pulcini: "if I see the stop iceberg
 * event with confirmation of my guess, NOW I would trade bigger").
 *
 * Unlike the rejected P&L-state scaling (win-scaling = leverage in
 * disguise), conviction scaling keys on INDEPENDENT evidence: the trade
 * is sized up because more confirmations fired, not because the day is
 * green. The replay tests whether the measured best subsets carry enough
 * extra expectancy to pay for the extra variance — through the MFF
 * account sim (EOD-trailing MLL, 30% consistency, >$900-day count as the
 * conservative consistency interpretation).
 *
 * Tier definitions (both measured best-subsets in the playbook):
 *   overlap      = A+ — both triggers fire on the same bar
 *                  (78.8% / PF 3.21 vs 77.5% / 2.98 combined)
 *   overlapOrBig = A+ OR the breakout bar clears 1.6× ATR14 (the
 *                  "huge-bar" class that defines the expansion trigger)
 *
 * Sizing: tier1 = the production $170 budget; tier2 = 170 × mult.
 * contracts = min(30, floor(budget ÷ (riskPts × $2))).
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/convictionTierStudy.ts [--max N] [--split 2026-01-01] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  closeOf,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { simulateAccount, accountLine } from "../lib/propAccount";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const BUDGET = 170;
const POINT_VALUE = 2;
const MAX_MICRO = 30;

type Scored = {
  date: string;
  pnlPts: number;
  riskPts: number;
  tier2: boolean;
  contracts: number;
  pnl: number; // dollars
  heldBars: number;
};

function sizeFor(riskPts: number, budget: number): number {
  return Math.min(MAX_MICRO, Math.max(1, Math.floor(budget / (Math.max(0.01, riskPts) * POINT_VALUE))));
}

function scoreTrade(minutes: MomMinute[], sig: MomentumSignal, date: string, mult: number, tier2: boolean): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0)) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;

  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.entryIdx;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      exit = stop;
      heldBars = j - sig.entryIdx;
      break;
    }
    if (tgtHit) {
      exit = target;
      heldBars = j - sig.entryIdx;
      break;
    }
  }
  const pnlPts = (exit - entry) * dir - COST_PTS;
  const budget = tier2 ? BUDGET * mult : BUDGET;
  const contracts = sizeFor(risk, budget);
  return {
    date,
    pnlPts,
    riskPts: risk,
    tier2,
    contracts,
    pnl: Math.round(pnlPts * POINT_VALUE * contracts * 100) / 100,
    heldBars,
  };
}

type Plan = { label: string; mult: number; tier: "overlap" | "overlapOrBig" };

function plans(): Plan[] {
  return [
    { label: "baseline (1.0 all)", mult: 1, tier: "overlap" },
    { label: "A+ 1.25×", mult: 1.25, tier: "overlap" },
    { label: "A+ 1.5×", mult: 1.5, tier: "overlap" },
    { label: "A+ 2.0×", mult: 2, tier: "overlap" },
    { label: "A+|huge 1.25×", mult: 1.25, tier: "overlapOrBig" },
    { label: "A+|huge 1.5×", mult: 1.5, tier: "overlapOrBig" },
    { label: "A+|huge 2.0×", mult: 2, tier: "overlapOrBig" },
  ];
}

function isTier2(sig: MomentumSignal, aPlus: boolean, tier: Plan["tier"]): boolean {
  if (tier === "overlap") return aPlus;
  return aPlus || (sig.breakRangeR ?? 0) >= 1.6;
}

/** one combined signal stream: same-bar double-fires dedupe to the
 *  momentum card (as the feed does), tagged A+ */
function combinedSignals(minutes: MomMinute[]): { sig: MomentumSignal; aPlus: boolean }[] {
  const mom = detectMomentum(minutes, MOM_PROD);
  const exp = detectExpansionScalp(minutes, EXP_PROD);
  const expKeys = new Set(exp.map((x) => `${x.d}|${x.dir}|${x.entryIdx}`));
  const byKey = new Map<string, MomentumSignal>();
  for (const s of [...exp, ...mom]) {
    const key = `${s.d}|${s.dir}|${s.entryIdx}`;
    if (!byKey.has(key) || s.kind !== "expansion") byKey.set(key, s);
  }
  return [...byKey.values()].map((sig) => ({
    sig,
    aPlus: expKeys.has(`${sig.d}|${sig.dir}|${sig.entryIdx}`) && sig.kind !== "expansion",
  }));
}

function replay(minutes: MomMinute[], date: string, plan: Plan): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const { sig, aPlus } of combinedSignals(minutes)) {
    if (sig.entryIdx <= openUntil) continue;
    const tier2 = isTier2(sig, aPlus, plan.tier);
    const sc = scoreTrade(minutes, sig, date, plan.mult, tier2);
    if (!sc) continue;
    out.push(sc);
    openUntil = sig.entryIdx + sc.heldBars;
  }
  return out;
}

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; offline: boolean } = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const splitDate = o.split ?? "2026-01-01";
  const plans_ = plans();

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions × ${plans_.length} plans (sequential, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit)`);

  const results = plans_.map((p) => ({ label: p.label, trades: [] as Scored[] }));

  const t0 = Date.now();
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      for (let p = 0; p < plans_.length; p++) {
        results[p].trades.push(...replay(minutes, date, plans_[p]));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  console.log(`CONVICTION-TIER SIZING (budget $${BUDGET}, tier2 ×mult, 30-micro cap) — full archive, eval sim:`);
  for (const r of results) {
    const all = r.trades;
    const tier2 = all.filter((t) => t.tier2);
    const test = all.filter((t) => t.date >= splitDate);
    const sim = simulateAccount(all, "eval");
    const testSim = simulateAccount(test, "eval");
    const byDay = new Map<string, number>();
    for (const t of all) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnl);
    const dayPnl = [...byDay.values()];
    dayPnl.sort((a, b) => a - b);
    const worst = dayPnl[0] ?? 0;
    const median = dayPnl[Math.floor(dayPnl.length / 2)] ?? 0;
    const best = dayPnl[dayPnl.length - 1] ?? 0;
    const over900 = dayPnl.filter((d) => d > 900).length;
    const total = all.reduce((a, t) => a + t.pnl, 0);
    const tier2Total = tier2.reduce((a, t) => a + t.pnl, 0);
    const tier2Share = total !== 0 ? (tier2Total / total) * 100 : 0;
    console.log(
      `${r.label.padEnd(16)} | n=${String(all.length).padStart(5)} tier2=${String(tier2.length).padStart(4)} | $${total.toFixed(0).padStart(9)} (tier2 ${tier2Share.toFixed(0)}%) | day med $${median.toFixed(0).padStart(6)} worst $${worst.toFixed(0).padStart(6)} best $${best.toFixed(0).padStart(7)} >$900:${String(over900).padStart(3)} | eval ${accountLine(sim)} | test ${accountLine(testSim)}`,
    );
  }

  console.log("\nTIER2 ANATOMY (the A+|huge 1.5× plan):");
  const p15 = results.find((r) => r.label === "A+|huge 1.5×")!;
  const t2 = p15.trades.filter((t) => t.tier2);
  const t1 = p15.trades.filter((t) => !t.tier2);
  const wr = (tt: Scored[]) => (tt.length ? (tt.filter((t) => t.pnl > 0).length / tt.length) * 100 : 0);
  const exp = (tt: Scored[]) => (tt.length ? tt.reduce((a, t) => a + t.pnl, 0) / tt.length : 0);
  console.log(
    `  tier1: n=${t1.length} wr=${wr(t1).toFixed(1)}% avg $${exp(t1).toFixed(0)}/trade | ` +
      `tier2: n=${t2.length} wr=${wr(t2).toFixed(1)}% avg $${exp(t2).toFixed(0)}/trade (at 1.5× size)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
