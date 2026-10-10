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
import { type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
// consolidated engine: canonical scorer + standard T1/T2/T4 + verdict
import { scoreTrade, scoreSequential as engineScoreSequential, coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5;

type Trade = { date: string; risk: number; pnl: number; heldBars?: number };

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, stopMult: number, targetMult: number, timeExit: number): Trade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * targetMult;
  // the consolidated engine's canonical scorer (stop-first, midpoint
  // close, 0.5 pt cost inside the P&L, last-bar fires dropped) — identical
  // semantics to the former inline loop.
  const sc = scoreTrade(minutes, { dir, entry, stop, target, entryIdx: sig.entryIdx, risk }, { costPts: COST_PTS, holdBars: timeExit });
  return sc ? { date, risk, pnl: sc.pnl, heldBars: sc.heldBars } : null;
}

function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number, targetMult: number, timeExit: number): Trade[] {
  // one-trade-at-a-time, full-window occupancy (openUntil = entryIdx +
  // timeExit) — the historical convention this optimizer always used.
  return engineScoreSequential(signals, (sig) => scoreSignal(minutes, sig, date, stopMult, targetMult, timeExit), { occupy: "full", window: timeExit });
}

function stats(trades: Trade[]) {
  // legacy {n, wr, pf, net} fed from the engine's canonical T1 stats —
  // identical formulas (wins = pnl > 0, pf = grossWin/grossLoss, net = Σpnl).
  const cs = coreStats(trades);
  return {
    n: cs.n,
    wr: cs.wr,
    pf: cs.pf,
    net: cs.netPts,
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

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Primary cohort = the full-history PASS winner (the script's own
   * conclusion: train-constrained picks are untrustworthy for RTH), else
   * the train winner. T1 core quality, T2 the train ranking, T4 prop
   * viability, five-slot verdict. ---- */
  const pick = full.length ? full[0] : rows[0];
  const pickIdx = combos.findIndex((x) => x.s === pick.s && x.t === pick.t && x.x === pick.x);
  const engineTrades: EngineTrade[] = perCombo[pickIdx].map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([
    { label: `primary s${pick.s} t${pick.t} x${pick.x} sz${pick.sz} (all)`, stats: coreStats(engineTrades) },
    { label: "train", stats: coreStats(engineTrades.filter((t) => t.date < split)) },
    { label: "test", stats: coreStats(engineTrades.filter((t) => t.date >= split)) },
  ]));
  console.log("\n" + renderT2(
    rows.slice(0, 12).map((r) => {
      const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
      const trainCs = coreStats(perCombo[c].filter((t) => t.date < split));
      const testCs = coreStats(perCombo[c].filter((t) => t.date >= split));
      return {
        rule: `s${r.s} t${r.t} x${r.x} sz${r.sz}`,
        n: trainCs.n,
        wr: trainCs.wr,
        ci: wilson95(trainCs.wins, trainCs.n),
        pf: trainCs.pf,
        expPts: trainCs.expPts,
        trainTest: `${trainCs.wr.toFixed(0)}% / ${testCs.wr.toFixed(0)}%`,
        compare: `base s1.0/t1.0/x60 train WR ${baseTrainStats.wr.toFixed(0)}%`,
      };
    }),
  ));
  const viability = propViability(engineTrades, { splitDate: split });
  console.log("\n" + renderT4(viability));
  const stdTrain = coreStats(engineTrades.filter((t) => t.date < split));
  const stdTest = coreStats(engineTrades.filter((t) => t.date >= split));
  console.log(
    "\n" +
      renderVerdict({
        edge: stdTest.netPts > 0 && stdTest.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(stdTrain.wr - stdTest.wr).toFixed(1)} pts`,
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
