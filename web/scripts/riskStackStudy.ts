/* ------------------------------------------------------------------ *
 * Risk-stack study — the FULL live configuration backtested together.
 *
 * Detects momentum + expansion (MOM_PROD/EXP_PROD, rr1.0) + RTH
 * (SOFT_PROD) + open drive (OPEN_PROD) over the archive, sequences
 * them GLOBALLY (the live account holds one MNQ position at a time),
 * scores exits (ladder = bank 2/3 + runner, or fixed 1R), applies the
 * LIVE sizing (momentum $170-budget · RTH/open fixed-9 capped at $200)
 * and the protection layers, then runs the MFF account simulator.
 *
 * Variants (all share the same trades; only the rules differ):
 *   fixed1R      fixed-1R exits, no protections      (pre-ladder era)
 *   ladder       ladder exits, no protections        (stack OFF)
 *   +tiers       2/3 size @ day +$300, 1/3 @ +$600
 *   +giveback    halt once the day gives back max($250, 50% of peak)
 *   full         ladder + caps + tiers + giveback    (THE LIVE STACK)
 *
 * Run from web/:
 *   node --import scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { scoreScaleOut, type ScaleOutTrade } from "../lib/runner";
import { coreStats, wilson95, propViability, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";

const CONCURRENCY = 8;
const COST = 0.5; // pts slippage+cost baked into the runner scorers
const COMM_PER_SIDE = 0.95;

type FamTag = "momentum" | "expansion" | "rth" | "open";

function detectAll(minutes: MomMinute[]): Array<{ s: MomentumSignal; fam: FamTag }> {
  const out: Array<{ s: MomentumSignal; fam: FamTag }> = [];
  for (const s of detectMomentum(minutes, MOM_PROD)) out.push({ s, fam: "momentum" });
  for (const s of detectExpansionScalp(minutes, EXP_PROD)) out.push({ s, fam: "expansion" });
  for (const s of detectSoftMomentum(minutes, SOFT_PROD)) out.push({ s, fam: "rth" });
  for (const s of detectOpenDrive(minutes, OPEN_PROD)) out.push({ s, fam: "open" });
  return out.sort((a, b) => a.s.entryIdx - b.s.entryIdx);
}

type Fixed = {
  pnl: number;
  risk: number;
  heldBars: number;
  ambiguous: boolean;
  hit: "stop" | "target" | "time";
};

function scoreFixed(
  minutes: MomMinute[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  targetR: number,
  maxBars: number,
): Fixed | null {
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0)) return null;
  const target = entry + dir * targetR * risk;
  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + maxBars);
  if (start > end) return null;
  let hit: Fixed["hit"] = "stop";
  let exit = stop0;
  let heldBars = 0;
  let ambiguous = false;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop0 : b.high >= stop0;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (j === start && stopHit && tgtHit) ambiguous = true;
    if (stopHit) {
      heldBars = j - entryIdx;
      break;
    }
    if (tgtHit) {
      exit = target;
      hit = "target";
      heldBars = j - entryIdx;
      break;
    }
  }
  if (hit === "stop" && heldBars === end - entryIdx) {
    const stopHitLast = dir > 0 ? minutes[end].low <= stop0 : minutes[end].high >= stop0;
    if (!stopHitLast) {
      hit = "time";
      exit = (minutes[end].high + minutes[end].low) / 2;
    }
  }
  return { pnl: (exit - entry) * dir - COST, risk, heldBars, ambiguous, hit };
}

type Trade = {
  date: string;
  fam: FamTag;
  pnlPts: number;
  riskPts: number;
  contracts: number;
  pnlUsd: number;
};

const sizeOf = (fam: FamTag, riskPts: number): number => {
  if (fam === "momentum" || fam === "expansion") {
    return Math.max(1, Math.min(30, Math.floor(170 / (riskPts * 2))));
  }
  return Math.max(1, Math.min(9, Math.floor(200 / (riskPts * 2)))); // RTH + open: $200 cap
};

type RuleSet = {
  name: string;
  exit: "ladder" | "fixed";
  tiers: Array<{ threshold: number; multiplier: number }>;
  giveBack: { pct: number; floor: number } | null;
};

const RULES: RuleSet[] = [
  { name: "fixed1R", exit: "fixed", tiers: [], giveBack: null },
  { name: "ladder", exit: "ladder", tiers: [], giveBack: null },
  { name: "+tiers", exit: "ladder", tiers: [{ threshold: 600, multiplier: 1 / 3 }, { threshold: 300, multiplier: 2 / 3 }], giveBack: null },
  { name: "+giveback", exit: "ladder", tiers: [], giveBack: { pct: 0.5, floor: 250 } },
  { name: "full", exit: "ladder", tiers: [{ threshold: 600, multiplier: 1 / 3 }, { threshold: 300, multiplier: 2 / 3 }], giveBack: { pct: 0.5, floor: 250 } },
];

const TIER_OF = (dayPnl: number, tiers: RuleSet["tiers"]) => {
  for (const t of [...tiers].sort((a, b) => b.threshold - a.threshold)) {
    if (dayPnl >= t.threshold) return t.multiplier;
  }
  return 1;
};

function runDay(rule: RuleSet, date: string, minutes: MomMinute[], signals: Array<{ s: MomentumSignal; fam: FamTag }>): Trade[] {
  const trades: Trade[] = [];
  {
    let dayPnl = 0;
    let dayPeak = 0;
    let halt = false;
    let openUntil = -1;
    for (const { s, fam } of signals) {
      if (s.entryIdx <= openUntil) continue; // one MNQ position at a time (flat rule)
      const dir = s.dir === "long" ? 1 : -1;
      const mb = fam === "rth" ? Math.min(60, Math.max(1, minutes.findIndex((m) => m.t === "15:00") - s.entryIdx)) : 60;
      if (mb < 1) continue;
      let pnlPts: number | null = null;
      let heldBars = 0;
      if (rule.exit === "ladder") {
        const t = scoreScaleOut(minutes, s.entry, s.stop, dir, s.entryIdx, { maxBars: mb, cost: COST });
        if (!t) continue;
        pnlPts = (t as ScaleOutTrade).pnl;
        heldBars = t.heldBars;
      } else {
        const targetR = fam === "rth" ? 0.75 : fam === "open" ? 15 / 35 : 1;
        const t = scoreFixed(minutes, s.entry, s.stop, dir, s.entryIdx, targetR, mb);
        if (!t) continue;
        pnlPts = t.pnl;
        heldBars = t.heldBars;
      }
      if (pnlPts === null) continue;
      if (halt) continue; // give-back halt: skip remaining entries today
      const riskPts = Math.abs(s.entry - s.stop);
      let contracts = sizeOf(fam, riskPts);
      const mult = TIER_OF(dayPnl, rule.tiers);
      if (mult < 1) contracts = Math.max(1, Math.round(contracts * mult));
      const pnlUsd = pnlPts * contracts * 2 - 2 * contracts * COMM_PER_SIDE;
      trades.push({ date, fam, pnlPts, riskPts, contracts, pnlUsd });
      dayPnl += pnlUsd;
      dayPeak = Math.max(dayPeak, dayPnl);
      openUntil = s.entryIdx + heldBars;
      if (rule.giveBack && dayPeak > rule.giveBack.floor) {
        const limit = Math.max(rule.giveBack.floor, rule.giveBack.pct * dayPeak);
        if (dayPnl <= dayPeak - limit) halt = true;
      }
    }
  }
  return trades;
}

async function main() {
  const offline = process.argv.includes("--offline");
  const dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  console.log(`risk-stack study · ${dates.length} sessions`);
  const t0 = Date.now();

  const accum = RULES.map((rule) => ({ rule, trades: [] as Trade[] }));
  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals = detectAll(minutes);
      if (!signals.length) continue;
      for (const a of accum) {
        a.trades.push(...runDay(a.rule, date, minutes, signals));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const results = accum.map(({ rule, trades }) => {
    const byDay = new Map<string, number>();
    for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnlUsd);
    const days = [...byDay.values()];
    const sorted = [...days].sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const total = trades.reduce((a, t) => a + t.pnlUsd, 0);
    const breaches = days.filter((d) => d > 900).length;
    const pGoal = (g: number) => (days.length ? ((days.filter((d) => d >= g).length / days.length) * 100).toFixed(0) : "0");
    const evalSim = simulateAccount(trades.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "eval");
    const funded = simulateAccount(trades.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "funded");
    return {
      name: rule.name,
      trades: trades.length,
      total,
      med,
      worst: sorted[0] ?? 0,
      p500: pGoal(500),
      p900: pGoal(900),
      breaches,
      evalSim,
      funded,
    };
  });

  console.log(`${"variant".padEnd(12)} ${"trades".padStart(7)} ${"total".padStart(12)} ${"median day".padStart(10)} ${"worst day".padStart(10)} ${"P≥500".padStart(6)} ${"P≥900".padStart(6)} ${">$900 days".padStart(11)}`);
  for (const r of results) {
    const totalStr = `${r.total >= 0 ? "+" : "−"}$${Math.abs(Math.round(r.total)).toLocaleString("en-US")}`;
    console.log(
      `${r.name.padEnd(12)} ${String(r.trades).padStart(7)} ${totalStr.padStart(12)} ${(r.med >= 0 ? "+$" : "−$").padStart(4) + String(Math.abs(Math.round(r.med))).padStart(6)} ${(r.worst <= 0 ? "−$" : "+$") + String(Math.abs(Math.round(r.worst))).padStart(9)} ${r.p500.padStart(5)}% ${r.p900.padStart(5)}% ${String(r.breaches).padStart(11)}`,
    );
    console.log(`              eval: ${accountLine(r.evalSim)}`);
    console.log(`              funded: ${accountLine(r.funded)}`);
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * primary cohort = the `full` variant (THE LIVE STACK); T1 core quality
   * (no train/test split — all row only), T2 variant ranking vs the
   * fixed1R baseline, T4 prop viability, five-slot verdict. ---- */
  const full = accum.find((a) => a.rule.name === "full")!.trades;
  const engineTrades = full.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const allStats = coreStats(engineTrades);
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "all", stats: allStats }]));
  const baseline = accum.find((a) => a.rule.name === "fixed1R")!;
  const baseStats = coreStats(baseline.trades.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
  console.log(
    "\n" +
      renderT2(
        accum.map(({ rule, trades }) => {
          const st = coreStats(trades.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
          return {
            rule: rule.name,
            n: st.n,
            wr: st.wr,
            ci: wilson95(st.wins, st.n),
            pf: st.pf,
            expPts: st.expPts,
            compare: rule.name === "fixed1R" ? undefined : `fixed1R WR ${baseStats.wr.toFixed(0)}%`,
          };
        }),
      ),
  );
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: allStats.netPts > 0 && allStats.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: "—",
        holdout: "n/a (validation pipeline)",
        viability:
          viability.pPass === null
            ? "n/a"
            : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
