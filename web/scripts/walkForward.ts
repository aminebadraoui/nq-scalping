/* ------------------------------------------------------------------ *
 * WALK-FORWARD — rolling-window re-optimization guardrail:
 *   windows of [150 train → 30 test], advance 30 sessions;
 *   in each window re-run the constrained grid search (same rule as
 *   sizingOptimizer: eval PASS + PF ≥ base×0.9 + dd bound) on the
 *   window's train segment, apply the pick to the window's test
 *   segment. Compare the concatenated walk-forward P&L against the
 *   STATIC winner (s0.4/t2/x60 ×3) applied to the same test segments.
 *
 *   A static pick that only wins because its train window got lucky
 *   will bleed here — this is the multiple-comparisons guardrail.
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/walkForward.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
// consolidated engine: canonical scorer + standard T1/T2/T4 + verdict
import { scoreTrade, scoreSequential as engineScoreSequential, coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const TRAIN_LEN = 150;
const TEST_LEN = 30;

const STOPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const TARGETS = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0];
const TIMES = [45, 60, 75, 90];
const SIZES = [2.0, 2.5, 3.0, 3.5, 4.0];

const STATIC = { s: 0.4, t: 2.0, x: 60, sz: 3.0 };

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

function scoreAll(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number, targetMult: number, timeExit: number): Trade[] {
  // one-trade-at-a-time, full-window occupancy (openUntil = entryIdx +
  // timeExit) — the historical convention this script always used.
  return engineScoreSequential(signals, (sig) => scoreSignal(minutes, sig, date, stopMult, targetMult, timeExit), { occupy: "full", window: timeExit });
}

function stats(trades: Trade[]) {
  // legacy {n, pf, net} fed from the engine's canonical T1 stats —
  // identical formulas (pf = grossWin/grossLoss, net = Σpnl).
  const cs = coreStats(trades);
  return { n: cs.n, pf: cs.pf, net: cs.netPts };
}

function sim(trades: Trade[]) {
  const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
  const acc = simulateAccount(d, "eval");
  let peak = 0;
  let dd = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    dd = Math.min(dd, day.equity - peak);
  }
  return { net: d.reduce((a, t) => a + t.pnl, 0), dd, passed: acc.breachDay === null, line: accountLine(acc) };
}

async function main() {
  const dates = await archiveDates();
  const combos = [...STOPS.flatMap((s) => TARGETS.flatMap((t) => TIMES.map((x) => ({ s, t, x })))), { s: 1.0, t: 1.0, x: 60 }];
  const perCombo: Trade[][] = combos.map(() => []);

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const signals = [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)];
      for (let c = 0; c < combos.length; c++) perCombo[c].push(...scoreAll(minutes, signals, date, combos[c].s, combos[c].t, combos[c].x));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${dates.length} sessions scored · ${combos.length} combos`);

  const baseIdx = combos.findIndex((c) => c.s === 1.0 && c.t === 1.0 && c.x === 60);
  const staticIdx = combos.findIndex((c) => c.s === STATIC.s && c.t === STATIC.t && c.x === STATIC.x);

  /* rolling windows */
  const wfTrades: Trade[] = [];
  const staticTrades: Trade[] = [];
  // unscaled 1-contract twins of the two aggregates — the engine's
  // standard block reads per-trade R-multiples, which sizing would distort.
  const wfRawTrades: Trade[] = [];
  const staticRawTrades: Trade[] = [];
  const rows: string[] = [];
  for (let w = 0; w + TRAIN_LEN + TEST_LEN <= dates.length; w += TEST_LEN) {
    const trainSpan = [dates[w], dates[w + TRAIN_LEN - 1]];
    const testSpan = [dates[w + TRAIN_LEN], dates[w + TRAIN_LEN + TEST_LEN - 1]];
    const inTrain = (t: Trade) => t.date >= trainSpan[0] && t.date <= trainSpan[1];
    const inTest = (t: Trade) => t.date >= testSpan[0] && t.date <= testSpan[1];

    const baseTrain = perCombo[baseIdx].filter(inTrain);
    const basePF = stats(baseTrain).pf;
    const baseDDSim = sim(baseTrain);

    let best: { s: number; t: number; x: number; sz: number; net: number } | null = null;
    for (let c = 0; c < combos.length; c++) {
      const train = perCombo[c].filter(inTrain);
      const st = stats(train);
      for (const sz of SIZES) {
        const sm = sim(train.map((t) => ({ ...t, pnl: t.pnl * sz })));
        const ok = sm.passed && st.pf >= basePF * 0.9 && sm.dd >= -1.25 * Math.abs(baseDDSim.dd) - 250;
        if (ok && (!best || sm.net > best.net)) best = { s: combos[c].s, t: combos[c].t, x: combos[c].x, sz, net: sm.net };
      }
    }

    const test = perCombo[staticIdx].filter(inTest);
    staticTrades.push(...test.map((t) => ({ ...t, pnl: t.pnl * STATIC.sz })));
    staticRawTrades.push(...test);
    if (best) {
      const bi = combos.findIndex((c) => c.s === best!.s && c.t === best!.t && c.x === best!.x);
      const wt = perCombo[bi].filter(inTest).map((t) => ({ ...t, pnl: t.pnl * best!.sz }));
      wfTrades.push(...wt);
      wfRawTrades.push(...perCombo[bi].filter(inTest));
      const wst = stats(wt);
      const wsm = sim(wt);
      rows.push(`${testSpan[0]}→${testSpan[1]} | pick s${best.s} t${best.t} x${best.x} ×${best.sz} | test pf ${wst.pf.toFixed(2)} net $${wsm.net.toFixed(0)} dd $${wsm.dd.toFixed(0)} ${wsm.line}`);
    } else {
      rows.push(`${testSpan[0]}→${testSpan[1]} | NO CONFIG PASSED (window skipped)`);
    }
  }

  console.log("\n=== WALK-FORWARD WINDOWS ===");
  for (const r of rows) console.log(r);

  const wfSim = sim(wfTrades);
  const stSim = sim(staticTrades);
  console.log("\n=== AGGREGATE ===");
  console.log(`walk-forward  : ${wfSim.line} · $${wfSim.net.toFixed(0)} · dd $${wfSim.dd.toFixed(0)}`);
  console.log(`static s0.4t2x60×3 : ${stSim.line} · $${stSim.net.toFixed(0)} · dd $${stSim.dd.toFixed(0)}`);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Primary cohort = the concatenated walk-forward test segments at
   * 1-contract (unsized). No train/test split (rolling windows), so T1
   * prints the "all" row only; T2 compares walk-forward vs the static
   * winner; T4 + verdict follow. ---- */
  const engineTrades: EngineTrade[] = wfRawTrades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "walk-forward (all, 1-contract)", stats: coreStats(engineTrades) }]));
  const wfCs = coreStats(engineTrades);
  const staticCs = coreStats(staticRawTrades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  console.log("\n" + renderT2([
    {
      rule: "walk-forward (rolling re-opt)",
      n: wfCs.n,
      wr: wfCs.wr,
      ci: wilson95(wfCs.wins, wfCs.n),
      pf: wfCs.pf,
      expPts: wfCs.expPts,
      compare: `static ×${STATIC.sz} wr ${staticCs.wr.toFixed(0)}%`,
    },
    {
      rule: `static s${STATIC.s} t${STATIC.t} x${STATIC.x} ×${STATIC.sz}`,
      n: staticCs.n,
      wr: staticCs.wr,
      ci: wilson95(staticCs.wins, staticCs.n),
      pf: staticCs.pf,
      expPts: staticCs.expPts,
      compare: `walk-forward wr ${wfCs.wr.toFixed(0)}%`,
    },
  ]));
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: wfCs.netPts > 0 && wfCs.expR > 0 ? "real" : "absent",
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
