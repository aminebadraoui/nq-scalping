/* ------------------------------------------------------------------ *
 * Winner validation — s0.4 stop / 2R target / 60-bar exit:
 *   1. year stability (2024 / 2025 / 2026)
 *   2. cost sensitivity (0.5 / 1.0 / 1.5 / 2.0 pt round-trip)
 *   3. WR decay across target multiples (the arithmetic check from
 *      the literature review: 2R must hold WR ≥ ~51%)
 * Same replay as sizingOptimizer; dumps per-trade rows for inspection.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import {
  scoreTrade,
  coreStats,
  wilson95,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
} from "../lib/backtestEngine";

const CONCURRENCY = 8;
const RTH_OPEN = "08:30";
const RTH_CLOSE = "15:00";

type Trade = { date: string; dir: "long" | "short"; risk: number; pnl: number; hit: "target" | "stop" | "time"; held: number; targetMult: number };

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, stopMult: number, targetMult: number, timeExit: number, cost: number): Trade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * targetMult;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  // consolidated engine scorer: pessimistic stop-first, `cost` pts,
  // parameterized time exit (closeOf midpoint fallback), last-bar signals
  // dropped — identical to the former local loop. `held` keeps the legacy
  // convention (a time exit reports the full timeExit, not the last bar).
  const sc = scoreTrade(
    minutes,
    { dir, entry, stop, target, entryIdx: sig.entryIdx, risk },
    { costPts: cost, holdBars: timeExit },
  );
  if (!sc) return null;
  return { date, dir: sig.dir, risk, pnl: sc.pnl, hit: sc.hit, held: sc.hit === "time" ? timeExit : sc.heldBars, targetMult };
}

function stats(trades: Trade[]) {
  // engine-backed (formulas identical: wins = pnl>0, losses = pnl<=0,
  // wr = wins/n, pf = gw/gl, net = Σ pnl)
  const s = coreStats(trades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return { n: s.n, wr: s.wr, pf: s.pf, net: s.netPts };
}

function sim(trades: Trade[], sizeMult: number) {
  const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl * sizeMult, riskPts: t.risk })));
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
  let dates = await archiveDates();
  const byDate = new Map<string, { minutes: MomMinute[]; signals: MomentumSignal[] }>();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      byDate.set(date, { minutes, signals: [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)] });
    }
    i += CONCURRENCY;
  }
  console.log(`${dates.length} sessions loaded`);

  /* score every candidate config once at 0.5pt; post-hoc cost shift is
   * exact because cost never changes which trades occur or their exits */
  const WINNER = "s0.35 t2.25 x60 sz3.5";
  const CONFIGS = [
    { name: "s0.35 t2   x45 sz4", s: 0.35, t: 2.0, x: 45, sz: 4 },
    { name: "s0.35 t2   x60 sz4", s: 0.35, t: 2.0, x: 60, sz: 4 },
    { name: WINNER, s: 0.35, t: 2.25, x: 60, sz: 3.5 },
    { name: "s0.35 t2.5 x75 sz3.5", s: 0.35, t: 2.5, x: 75, sz: 3.5 },
    { name: "s0.3  t2.5 x60 sz3.5", s: 0.3, t: 2.5, x: 60, sz: 3.5 },
    { name: "s0.3  t3   x60 sz3", s: 0.3, t: 3.0, x: 60, sz: 3 },
    { name: "s0.4  t2   x60 sz3 (prev)", s: 0.4, t: 2.0, x: 60, sz: 3 },
    { name: "s1.0  t1   x60 sz1 (base)", s: 1.0, t: 1.0, x: 60, sz: 1 },
  ];
  const scored = new Map<string, Trade[]>();
  for (const c of CONFIGS) {
    const t: Trade[] = [];
    for (const date of dates) {
      const s = byDate.get(date);
      if (!s) continue;
      t.push(...scoreAll(s.minutes, s.signals, date, c.s, c.t, c.x, 0.5));
    }
    scored.set(c.name, t);
  }
  console.log("\n=== COST LADDER × CONFIG (per-config size, all years) ===");
  for (const cost of [0.5, 1.0, 1.5, 2.0]) {
    console.log(`--- ${cost.toFixed(1)}pt round trip ---`);
    for (const c of CONFIGS) {
      const t = (scored.get(c.name) ?? []).map((x) => ({ ...x, pnl: x.pnl - (cost - 0.5) }));
      const st = stats(t);
      const sm = sim(t, c.sz);
      console.log(`${c.name.padEnd(24)} | wr=${st.wr.toFixed(1).padStart(5)}% pf=${st.pf.toFixed(2).padStart(5)} net=${st.net.toFixed(0).padStart(6)}pts | $${sm.net.toFixed(0).padStart(7)} dd $${sm.dd.toFixed(0).padStart(6)} ${sm.line}`);
    }
  }

  /* WR decay across targets (stop fixed 0.35, time 60) */
  console.log("\n=== WR DECAY vs TARGET (s0.35 / x60 / 0.5pt) ===");
  for (const tm of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.25, 2.5, 3.0]) {
    const t: Trade[] = [];
    for (const date of dates) {
      const s = byDate.get(date);
      if (!s) continue;
      t.push(...scoreAll(s.minutes, s.signals, date, 0.35, tm, 60, 0.5));
    }
    const st = stats(t);
    const need = (1 / (1 + tm)) * 100;
    console.log(`${tm}R: n=${st.n} wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts (breakeven WR ${need.toFixed(0)}%)`);
  }

  /* sizing × cost frontier on the winner */
  console.log(`\n=== SIZING × COST FRONTIER (${WINNER}) ===`);
  for (const size of [2, 3, 3.5, 4, 5]) {
    for (const cost of [0.5, 0.6, 0.75, 0.95, 1.0]) {
      const t = (scored.get(WINNER) ?? []).map((x) => ({ ...x, pnl: x.pnl - (cost - 0.5) }));
      const st = stats(t);
      const sm = sim(t, size);
      console.log(`x${size} @ ${cost.toFixed(2)}pt | wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts | $${sm.net.toFixed(0)} dd $${sm.dd.toFixed(0)} ${sm.line}`);
    }
  }

  /* 3R variant — does a 3R target at smaller size tie the winner? */
  console.log("\n=== 3R VARIANT (s0.35/t3/x60) × SIZES × COSTS ===");
  const t3: Trade[] = [];
  for (const date of dates) {
    const s = byDate.get(date);
    if (!s) continue;
    t3.push(...scoreAll(s.minutes, s.signals, date, 0.35, 3.0, 60, 0.5));
  }
  for (const size of [2, 2.5, 3, 3.5, 4]) {
    for (const cost of [0.5, 0.75, 0.95, 1.0]) {
      const t = t3.map((x) => ({ ...x, pnl: x.pnl - (cost - 0.5) }));
      const st = stats(t);
      const sm = sim(t, size);
      console.log(`x${size} @ ${cost.toFixed(2)}pt | wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts | $${sm.net.toFixed(0)} dd $${sm.dd.toFixed(0)} ${sm.line}`);
    }
  }

  /* full comparison — per-year × cost for the three reference configs */
  console.log("\n=== FULL COMPARISON (base vs prev winner vs new winner) ===");
  const REFS = [
    { name: "base    s1.0 t1   x60 sz1", s: 1.0, t: 1.0, x: 60, sz: 1 },
    { name: "prev    s0.4  t2   x60 sz3", s: 0.4, t: 2.0, x: 60, sz: 3 },
    { name: "new     s0.35 t2.25 x60 sz3.5", s: 0.35, t: 2.25, x: 60, sz: 3.5 },
    { name: "new@2   s0.35 t2.25 x60 sz2", s: 0.35, t: 2.25, x: 60, sz: 2 },
  ];
  for (const cost of [0.5, 0.95]) {
    console.log(`--- ${cost.toFixed(2)}pt round trip ---`);
    for (const c of REFS) {
      const t: Trade[] = [];
      for (const date of dates) {
        const s = byDate.get(date);
        if (!s) continue;
        t.push(...scoreAll(s.minutes, s.signals, date, c.s, c.t, c.x, cost));
      }
      const st = stats(t);
      const sm = sim(t, c.sz);
      const byYear = ["2024", "2025", "2026"].map((y) => {
        const yy = t.filter((x) => x.date.startsWith(y));
        const s2 = stats(yy);
        const sm2 = sim(yy, c.sz);
        return `${y} wr=${s2.wr.toFixed(1)}% pf=${s2.pf.toFixed(2)} $${sm2.net.toFixed(0)}`;
      });
      console.log(`${c.name.padEnd(26)} | all: wr=${st.wr.toFixed(1).padStart(5)}% pf=${st.pf.toFixed(2).padStart(5)} net=${st.net.toFixed(0).padStart(6)}pts $${sm.net.toFixed(0).padStart(7)} dd $${sm.dd.toFixed(0).padStart(6)} ${sm.line}`);
      console.log(`${"".padEnd(26)} | ${byYear.join(" · ")}`);
    }
  }

  /* year stability of the top candidates */
  console.log("\n=== YEAR STABILITY @0.5pt (new winner vs prev winner) ===");
  for (const name of [WINNER, "s0.35 t2   x60 sz4", "s0.4  t2   x60 sz3 (prev)"]) {
    const c = CONFIGS.find((x) => x.name === name)!;
    const t = scored.get(name) ?? [];
    const byYear = ["2024", "2025", "2026"].map((y) => {
      const yy = t.filter((x) => x.date.startsWith(y));
      const st = stats(yy);
      const sm = sim(yy, c.sz);
      return `${y}: wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} net=${st.net.toFixed(0)}pts $${sm.net.toFixed(0)} ${sm.passed ? "PASS" : "BREACH"}`;
    });
    console.log(`${name.padEnd(24)} | ${byYear.join(" | ")}`);
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Primary cohort = the new winner config scored at 0.5 pt (raw trades;
   * size multipliers apply only in the sim layer). The script has no
   * train/test split (year stability instead) → only the "all" row. ---- */
  const engineTrades = (scored.get(WINNER) ?? []).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "all", stats: coreStats(engineTrades) }]));
  {
    const base = coreStats((scored.get("s1.0  t1   x60 sz1 (base)") ?? []).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    console.log("\n" + renderT2(CONFIGS.map((c) => {
      const trades = (scored.get(c.name) ?? []).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
      const s = coreStats(trades);
      return {
        rule: c.name,
        n: s.n,
        wr: s.wr,
        ci: wilson95(s.wins, s.n),
        pf: s.pf,
        expPts: s.expPts,
        compare: c.name === "s1.0  t1   x60 sz1 (base)" ? "—" : `base WR ${base.wr.toFixed(1)}%`,
      };
    })));
  }
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  const allStats = coreStats(engineTrades);
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

function scoreAll(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number, targetMult: number, timeExit: number, cost: number): (Trade & { entry: number })[] {
  const out: (Trade & { entry: number })[] = [];
  let openUntil = -1;
  for (const sig of signals) {
    if (sig.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, sig, date, stopMult, targetMult, timeExit, cost);
    if (!sc) continue;
    out.push({ ...sc, entry: sig.entry });
    openUntil = sig.entryIdx + timeExit;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
