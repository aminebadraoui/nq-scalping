/* ------------------------------------------------------------------ *
 * A+ daily-rules study — the owner's day plan, backtested over the
 * full archive, on two switchable pools:
 *
 *   --pool ap    A+ setups only (momentum A+ + RTH A+)
 *   --pool all   regular + A+ across ALL live strategies (momentum,
 *                expansion, RTH, open drive)   [default]
 *
 * Setup pools, trade mechanics and the rule variants live in
 * lib/apPlan.ts (shared with apChallengeTiming.ts / apPlanSweep.ts).
 * This CLI replays the four rule variants (base / loss-300 /
 * profit-400 / full) and prints the measured tables that back
 * docs/research/ap-daily-rules-2026-10-05.md and
 * docs/research/ap-full-pool-2026-10-05.md.
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs scripts/apRulesStudy.ts \
 *     [--pool ap|all] [--offline] [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { simulateAccount, accountLine } from "../lib/propAccount";
import type { MomMinute } from "../lib/momentum";
import {
  RISK_CAP,
  TARGET_R,
  LOSS_HALT,
  PROFIT_ARM,
  detectPool,
  runDay,
  RULES,
  type Scored,
  type RuleSet,
  type PoolMode,
  type PoolSignal,
} from "../lib/apPlan";

const CONCURRENCY = 8;

/* ---------------- report helpers ---------------- */

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const usd = (n: number) => `${n < 0 ? "−$" : "+$"}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

type VariantReport = {
  rule: RuleSet;
  trades: Scored[];
  byDay: Map<string, { pnl: number; n: number; halted: string }>;
  skippedByHalt: number;
};

async function main() {
  const argv = process.argv;
  const pool: PoolMode = argv.includes("--pool") ? (argv[argv.indexOf("--pool") + 1] === "ap" ? "ap" : "all") : "all";
  const offline = argv.includes("--offline");
  const dump = argv.includes("--dump") ? argv[argv.indexOf("--dump") + 1] : null;
  const dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL or use --offline with a manifest)");
    process.exit(1);
  }
  console.log(`A+ daily-rules study · pool=${pool} · ${dates.length} sessions · $${RISK_CAP} risk · ${TARGET_R}R target · day stop ${usd(LOSS_HALT)} · +$${PROFIT_ARM} one-more-trade rule`);
  console.log(`pool: ${pool === "ap" ? "A+ setups only" : "regular + A+ across all live strategies (momentum, expansion, RTH, open drive)"}\n`);
  const t0 = Date.now();

  const accum = RULES.map((rule) => ({
    rule,
    trades: [] as Scored[],
    byDay: new Map<string, { pnl: number; n: number; halted: string }>(),
    skippedByHalt: 0,
  })) as VariantReport[];

  const poolCount: { fam: string; n: number; aPlus: number }[] = [];
  let poolSessions = 0;
  let loaded = 0;

  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals: PoolSignal[] = detectPool(minutes as MomMinute[], pool);
      if (!signals.length) continue;
      poolSessions++;
      for (const ps of signals) {
        const p = poolCount.find((x) => x.fam === ps.fam);
        if (p) { p.n++; if (ps.aPlus) p.aPlus++; }
        else poolCount.push({ fam: ps.fam, n: 1, aPlus: ps.aPlus ? 1 : 0 });
      }
      for (const a of accum) {
        const run = runDay(a.rule, date, minutes as MomMinute[], signals);
        a.trades.push(...run.trades);
        a.byDay.set(date, { pnl: run.dayPnl, n: run.trades.length, halted: run.halted });
        a.skippedByHalt += run.skippedByHalt;
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${poolSessions} with signals\n`);

  /* ---- pool anatomy ---- */
  console.log("POOL");
  console.log(`${"family".padEnd(10)} ${"signals".padStart(8)} ${"traded".padStart(7)} ${"A+".padStart(5)} ${"sessions".padStart(9)}`);
  for (const p of poolCount) {
    const traded = accum[0].trades.filter((t) => t.fam === p.fam).length;
    const sess = new Set(accum[0].trades.filter((t) => t.fam === p.fam).map((t) => t.date)).size;
    console.log(`${p.fam.padEnd(10)} ${String(p.n).padStart(8)} ${String(traded).padStart(7)} ${String(p.aPlus).padStart(5)} ${String(sess).padStart(9)}`);
  }
  const base = accum[0];
  console.log(`\nplan mechanics on the pool (base variant, flat rule):`);
  const poolByFam = new Map<string, Scored[]>();
  for (const t of base.trades) {
    const arr = poolByFam.get(t.fam) ?? [];
    arr.push(t);
    poolByFam.set(t.fam, arr);
  }
  for (const [fam, arr] of poolByFam) {
    const wins = arr.filter((t) => t.hit === "target").length;
    const stops = arr.filter((t) => t.hit === "stop").length;
    const time = arr.length - wins - stops;
    console.log(
      `  ${fam.padEnd(10)} WR ${((100 * wins) / arr.length).toFixed(1).padStart(5)}% · stop ${((100 * stops) / arr.length).toFixed(1).padStart(5)}% · time ${((100 * time) / arr.length).toFixed(1).padStart(4)}% · med risk ${med(arr.map((t) => t.riskPts)).toFixed(1)} pts · med ${arr.length ? arr.map((t) => t.contracts).sort((x, y) => x - y)[Math.floor(arr.length / 2)] : 0} MNQ · net ${usd(sum(arr.map((t) => t.pnlUsd)))}`,
    );
  }

  /* ---- variants table ---- */
  console.log(`\n${"variant".padEnd(12)} ${"trades".padStart(7)} ${"wr".padStart(5)} ${"net".padStart(12)} ${"median day".padStart(11)} ${"worst day".padStart(11)} ${"P≥400".padStart(6)} ${"P≤−300".padStart(7)} ${"halted days".padStart(12)} ${"skipped".padStart(8)}`);
  const dumpOut: Record<string, unknown> = { pool: Object.fromEntries(poolCount.map((p) => [p.fam, { n: p.n, aPlus: p.aPlus }])) };
  for (const a of accum) {
    const t = a.trades;
    const wins = t.filter((x) => x.pnlUsd > 0).length;
    const days = [...a.byDay.values()];
    const pnls = days.map((d) => d.pnl);
    const haltedLoss = [...a.byDay.entries()].filter(([, d]) => d.halted === "loss").length;
    const haltedProfit = [...a.byDay.entries()].filter(([, d]) => d.halted === "profit").length;
    const evalSim = simulateAccount(t.map((x) => ({ date: x.date, pnl: x.pnlUsd })), "eval");
    const funded = simulateAccount(t.map((x) => ({ date: x.date, pnl: x.pnlUsd })), "funded");
    const line = `${a.rule.name.padEnd(12)} ${String(t.length).padStart(7)} ${t.length ? ((100 * wins) / t.length).toFixed(0).padStart(4) : "  —"}% ${usd(sum(t.map((x) => x.pnlUsd))).padStart(12)} ${usd(med(pnls)).padStart(11)} ${usd(Math.min(...pnls)).padStart(11)} ${pnls.length ? ((100 * pnls.filter((d) => d >= PROFIT_ARM).length) / pnls.length).toFixed(0).padStart(5) : "  —"}% ${pnls.length ? ((100 * pnls.filter((d) => d <= LOSS_HALT).length) / pnls.length).toFixed(0).padStart(6) : "  —"}% ${String(haltedLoss + haltedProfit).padStart(12)} ${String(a.skippedByHalt).padStart(8)}`;
    console.log(line);
    console.log(`              halted: loss-rule ${haltedLoss} days · profit-rule ${haltedProfit} days · eval: ${accountLine(evalSim)}`);
    console.log(`              funded: ${accountLine(funded)}`);
    const byYear: Record<string, number> = {};
    for (const x of t) byYear[x.date.slice(0, 4)] = (byYear[x.date.slice(0, 4)] ?? 0) + x.pnlUsd;
    dumpOut[a.rule.name] = {
      trades: t.length,
      wins,
      netUsd: sum(t.map((x) => x.pnlUsd)),
      medianDay: med(pnls),
      worstDay: Math.min(...pnls),
      bestDay: Math.max(...pnls),
      haltedLossDays: haltedLoss,
      haltedProfitDays: haltedProfit,
      skippedByHalt: a.skippedByHalt,
      eval: evalSim,
      funded,
      byYear,
      tradeList: t.map((x) => ({ date: x.date, fam: x.fam, dir: x.dir, riskPts: x.riskPts, contracts: x.contracts, hit: x.hit, pnlUsd: x.pnlUsd, grossTargetUsd: x.grossTargetUsd })),
    };
  }

  /* ---- per-year + per-family for base vs full ---- */
  for (const name of ["base", "full"]) {
    const a = accum.find((x) => x.rule.name === name)!;
    console.log(`\n${name.toUpperCase()} per year:`);
    const byYear = new Map<string, number[]>();
    for (const t of a.trades) {
      const y = t.date.slice(0, 4);
      const arr = byYear.get(y) ?? [];
      arr.push(t.pnlUsd);
      byYear.set(y, arr);
    }
    for (const [y, arr] of [...byYear.entries()].sort()) {
      console.log(`  ${y}: ${String(arr.length).padStart(4)} trades · net ${usd(sum(arr)).padStart(10)}`);
    }
    console.log(`  per family:`);
    const byFam = new Map<string, number[]>();
    for (const t of a.trades) {
      const arr = byFam.get(t.fam) ?? [];
      arr.push(t.pnlUsd);
      byFam.set(t.fam, arr);
    }
    for (const [f, arr] of [...byFam.entries()].sort((x, y) => sum(y[1]) - sum(x[1]))) {
      const wr = (100 * arr.filter((x) => x > 0).length) / arr.length;
      console.log(`    ${f.padEnd(10)} ${String(arr.length).padStart(5)} trades · wr ${wr.toFixed(0).padStart(3)}% · net ${usd(sum(arr)).padStart(10)}`);
    }
  }

  /* ---- day-ending reasons for the full variant ---- */
  const full = accum.find((x) => x.rule.name === "full")!;
  const endDays = [...full.byDay.entries()].map(([date, d]) => ({ date, ...d }));
  const endBy = new Map<string, { n: number; pnl: number[] }>();
  for (const d of endDays) {
    const k = d.halted === "none" ? "session end (no halt)" : `halt: ${d.halted} rule`;
    const e = endBy.get(k) ?? { n: 0, pnl: [] };
    e.n++;
    e.pnl.push(d.pnl);
    endBy.set(k, e);
  }
  console.log(`\nFULL day endings:`);
  for (const [k, e] of [...endBy.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${k.padEnd(26)} ${String(e.n).padStart(4)} days · median ${usd(med(e.pnl)).padStart(10)} · worst ${usd(Math.min(...e.pnl)).padStart(10)}`);
  }

  /* ---- contracts histogram (cap sizing) ---- */
  console.log(`\ncontracts under the $${RISK_CAP} cap (base pool):`);
  const hist = new Map<number, number>();
  for (const t of base.trades) hist.set(t.contracts, (hist.get(t.contracts) ?? 0) + 1);
  for (const [c, n] of [...hist.entries()].sort((x, y) => x[0] - y[0])) {
    console.log(`  ${String(c).padStart(2)} MNQ: ${String(n).padStart(5)} trades`);
  }

  if (dump) {
    dumpOut.generated = new Date().toISOString();
    dumpOut.sessions = dates.length;
    dumpOut.config = { riskCap: RISK_CAP, targetR: TARGET_R, lossHalt: LOSS_HALT, profitArm: PROFIT_ARM };
    await fs.writeFile(dump, JSON.stringify(dumpOut, null, 1));
    console.log(`\naggregates dumped → ${dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
