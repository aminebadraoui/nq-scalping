/* ------------------------------------------------------------------ *
 * RTH SIZING OPTIMIZER — the same campaign as sizingOptimizer.ts but
 * for the RTH soft-continuation family (detectSoftMomentum / SOFT_PROD).
 * Grid STOP × TARGET × TIME-EXIT × SIZE on the training window (before
 * --split), constrained selection (eval PASS + PF ≥ base×0.9 + dd
 * bound), out-of-sample check, then full-history validation of the top
 * configs: cost ladder (incl. the measured 0.95pt), year stability, and
 * the WR-decay curve across targets.
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/rthOptimizer.ts [--split 2026-01-01]
 * ------------------------------------------------------------------ */

import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";

const CONCURRENCY = 8;
const COST_PTS = 0.5;

type Trade = { date: string; risk: number; pnl: number };

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, stopMult: number, targetMult: number, timeExit: number): Trade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * targetMult;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + timeExit);
  if (start > end) return null;
  let exit = closeOf(minutes[end]);
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return { date, risk, pnl: (exit - entry) * dir - COST_PTS };
}

function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number, targetMult: number, timeExit: number): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const sig of signals) {
    if (sig.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, sig, date, stopMult, targetMult, timeExit);
    if (!sc) continue;
    out.push(sc);
    openUntil = sig.entryIdx + timeExit;
  }
  return out;
}

function stats(trades: { pnl: number }[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    n: trades.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net: trades.reduce((a, t) => a + t.pnl, 0),
  };
}

function sim(trades: Trade[], sizeMult: number) {
  const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl * sizeMult, riskPts: t.risk })));
  const acc = simulateAccount(d, "eval");
  let peak = 0;
  let maxDD = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  const net = d.reduce((a, t) => a + t.pnl, 0);
  return { net, maxDD, passed: acc.breachDay === null, line: accountLine(acc) };
}

async function main() {
  const args = process.argv.slice(2);
  const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "2026-01-01";
  const dates = await archiveDates();

  const STOPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  const TARGETS = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0];
  const TIMES = [45, 60, 75, 90];
  const SIZES = [2.0, 2.5, 3.0, 3.5, 4.0];
  const combos = [...STOPS.flatMap((s) => TARGETS.flatMap((t) => TIMES.map((x) => ({ s, t, x })))), { s: 1.0, t: 1.0, x: 60 }];
  const perCombo: Trade[][] = combos.map(() => []);
  const cached = new Map<string, { minutes: MomMinute[]; signals: MomentumSignal[] }>();

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const signals = detectSoftMomentum(minutes, SOFT_PROD);
      cached.set(date, { minutes, signals });
      for (let c = 0; c < combos.length; c++) perCombo[c].push(...scoreSequential(minutes, signals, date, combos[c].s, combos[c].t, combos[c].x));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${dates.length} sessions · ${combos.length} combos`);

  const baseIdx = combos.findIndex((c) => c.s === 1.0 && c.t === 1.0 && c.x === 60);
  const baseTrain = sim(perCombo[baseIdx].filter((t) => t.date < split), 1.0);
  const baseTest = sim(perCombo[baseIdx].filter((t) => t.date >= split), 1.0);
  const baseTrainStats = stats(perCombo[baseIdx].filter((t) => t.date < split));
  const baseAll = sim(perCombo[baseIdx], 1.0);
  console.log(`\nbase s1.0/t1.0/x60 ×1: train ${baseTrain.line} · test ${baseTest.line}`);
  console.log(`base all-sessions: ${baseAll.line} · train PF ${baseTrainStats.pf.toFixed(2)} · WR ${baseTrainStats.wr.toFixed(1)}% · train dd $${baseTrain.maxDD.toFixed(0)}`);

  /* ---- grid evaluation on TRAIN ---- */
  type Row = { s: number; t: number; x: number; sz: number; pf: number; net: number; dd: number; pass: boolean };
  const rows: Row[] = [];
  for (let c = 0; c < combos.length; c++) {
    const train = perCombo[c].filter((tr) => tr.date < split);
    const st = stats(train);
    for (const sz of SIZES) {
      const sm = sim(train, sz);
      const ok = sm.passed && st.pf >= baseTrainStats.pf * 0.9 && sm.maxDD >= -1.25 * Math.abs(baseTrain.maxDD) * sz - 250;
      rows.push({ s: combos[c].s, t: combos[c].t, x: combos[c].x, sz, pf: st.pf, net: sm.net, dd: sm.maxDD, pass: ok });
    }
  }
  rows.sort((a, b) => (b.pass ? b.net : -Infinity) - (a.pass ? a.net : -Infinity));
  console.log("\n=== TOP 12 CONFIGS ON TRAIN (constrained) ===");
  for (const r of rows.slice(0, 12)) {
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | pf ${r.pf.toFixed(2)} | net $${r.net.toFixed(0).padStart(7)} | dd $${r.dd.toFixed(0).padStart(6)} | ${r.pass ? "✓" : "✗"}`);
  }

  console.log("\n=== TOP-5 OUT-OF-SAMPLE (test window) ===");
  for (const r of rows.slice(0, 5)) {
    const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
    const test = perCombo[c].filter((tr) => tr.date >= split);
    const st = stats(test);
    const sm = sim(test, r.sz);
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | test n=${st.n} wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=$${sm.net.toFixed(0)} dd=$${sm.maxDD.toFixed(0)} ${sm.line}`);
  }

  /* ---- full-history validation of the top-4 configs ---- */
  console.log("\n=== FULL-HISTORY COST LADDER (top-4, per-config size) ===");
  for (const cost of [0.5, 0.75, 0.95, 1.0]) {
    console.log(`--- ${cost.toFixed(2)}pt round trip ---`);
    for (const r of rows.slice(0, 4)) {
      const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
      const t = perCombo[c].map((x) => ({ ...x, pnl: x.pnl - (cost - COST_PTS) }));
      const st = stats(t);
      const sm = sim(t, r.sz);
      console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | wr=${st.wr.toFixed(1).padStart(5)}% pf=${st.pf.toFixed(2).padStart(5)} net=${st.net.toFixed(0).padStart(7)}pts | $${sm.net.toFixed(0).padStart(7)} dd $${sm.maxDD.toFixed(0).padStart(6)} ${sm.line}`);
    }
  }

  /* ---- year stability of the top-3 at 0.5pt ---- */
  console.log("\n=== YEAR STABILITY @0.5pt (top-3) ===");
  for (const r of rows.slice(0, 3)) {
    const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
    const byYear = ["2024", "2025", "2026"].map((y) => {
      const yy = perCombo[c].filter((t) => t.date.startsWith(y));
      const st = stats(yy);
      const sm = sim(yy, r.sz);
      return `${y}: wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts $${sm.net.toFixed(0)} ${sm.passed ? "PASS" : "BREACH"}`;
    });
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | ${byYear.join(" | ")}`);
  }

  /* ---- full-history PASS filter (RTH dd is regime-dependent, so the
   * train-constrained pick is not trustworthy — select configs that pass
   * the ENTIRE history instead) ---- */
  console.log("\n=== FULL-HISTORY PASS FILTER @0.5pt (top-10 by net) ===");
  const full: Row[] = [];
  for (let c = 0; c < combos.length; c++) {
    const st = stats(perCombo[c]);
    for (const sz of SIZES) {
      const sm = sim(perCombo[c], sz);
      if (sm.passed && st.pf >= 2.5) full.push({ s: combos[c].s, t: combos[c].t, x: combos[c].x, sz, pf: st.pf, net: sm.net, dd: sm.maxDD, pass: true });
    }
  }
  full.sort((a, b) => b.net - a.net);
  for (const r of full.slice(0, 10)) {
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | pf ${r.pf.toFixed(2)} | net $${r.net.toFixed(0).padStart(7)} | dd $${r.dd.toFixed(0).padStart(6)} | ✓`);
  }
  console.log(`passing rows: ${full.length} / ${combos.length * SIZES.length}`);

  /* ---- cost ladder on the full-history PASSING top-3 ---- */
  console.log("\n=== COST LADDER (full-history passing top-3, per-config size) ===");
  for (const cost of [0.5, 0.75, 0.95, 1.0]) {
    console.log(`--- ${cost.toFixed(2)}pt round trip ---`);
    for (const r of full.slice(0, 3)) {
      const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
      const t = perCombo[c].map((x) => ({ ...x, pnl: x.pnl - (cost - COST_PTS) }));
      const st = stats(t);
      const sm = sim(t, r.sz);
      console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | wr=${st.wr.toFixed(1).padStart(5)}% pf=${st.pf.toFixed(2).padStart(5)} net=${st.net.toFixed(0).padStart(7)}pts | $${sm.net.toFixed(0).padStart(7)} dd $${sm.maxDD.toFixed(0).padStart(6)} ${sm.line}`);
    }
  }

  /* ---- max safe size at 0.95pt for the best passing combo ---- */
  console.log("\n=== SIZING × COST (best full-history pass config) ===");
  if (full.length) {
    const b = full[0];
    const c = combos.findIndex((x) => x.s === b.s && x.t === b.t && x.x === b.x);
    for (const sz of [1, 1.5, 2, 2.5, 3, 3.5, 4]) {
      for (const cost of [0.5, 0.75, 0.95]) {
        const t = perCombo[c].map((x) => ({ ...x, pnl: x.pnl - (cost - COST_PTS) }));
        const sm = sim(t, sz);
        console.log(`x${sz} @ ${cost.toFixed(2)}pt | $${sm.net.toFixed(0).padStart(7)} dd $${sm.maxDD.toFixed(0).padStart(6)} ${sm.line}`);
      }
    }
  }

  /* ---- year stability of the full-history passing top-3 ---- */
  console.log("\n=== YEAR STABILITY @0.5pt (full-history passing top-3) ===");
  for (const r of full.slice(0, 3)) {
    const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
    const byYear = ["2024", "2025", "2026"].map((y) => {
      const yy = perCombo[c].filter((t) => t.date.startsWith(y));
      const st = stats(yy);
      const sm = sim(yy, r.sz);
      return `${y}: wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts $${sm.net.toFixed(0)} ${sm.passed ? "PASS" : "BREACH"}`;
    });
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | ${byYear.join(" | ")}`);
  }

  /* ---- WR decay for the winning stop × time ---- */
  const best = rows[0];
  console.log(`\n=== WR DECAY vs TARGET (s${best.s} / x${best.x} / 0.5pt, all sessions) ===`);
  for (const tm of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.25, 2.5, 3.0]) {
    const t: Trade[] = [];
    for (const date of dates) {
      const s = cached.get(date);
      if (!s) continue;
      t.push(...scoreSequential(s.minutes, s.signals, date, best.s, tm, best.x));
    }
    const st = stats(t);
    console.log(`${tm}R: n=${st.n} wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts (breakeven ${(100 / (1 + tm)).toFixed(0)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
