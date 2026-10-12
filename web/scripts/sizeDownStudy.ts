/* ------------------------------------------------------------------ *
 * Size-down study — cap 5 contracts · $50 max risk · +$200 daily target.
 *
 * The question: if we size DOWN from the plan default ($100/trade,
 * 30-micro cap) to (max 5 contracts, $50 hard dollar-risk ceiling,
 * stop trading once a day books +$200), what happens to the prop
 * deployment math — P(pass before breach) on the eval, P(breach) on
 * eval and funded, and time-to-pass / time-to-first-payout?
 *
 * Trade stream: the production pair (MOM_PROD + EXP_PROD) scored with
 * the consolidated engine's canonical scorer (sequential, one position
 * at a time, pessimistic same-bar stop-first, 0.5 pt round-trip cost,
 * 60-bar time exit, no-bars dropped) — the same stream every sizing
 * study replays.
 *
 * Configs (same point stream; sizing differs):
 *   prod $100/30µ        baseline — dollarize budget $100, plan 30-micro cap
 *   cap5 $50             sizing only — contracts = min(5, floor($50/(risk×$2))),
 *                        floored at 1; trades whose stop would risk > $50 even
 *                        at 1 contract (risk > 25 pts) are SKIPPED
 *   cap5 $50 + $200/day  the proposal — config 2 plus a daily profit arm:
 *                        once a day's P&L reaches +$200, no new trades that
 *                        day (the trade that crosses it counts, then stop)
 *
 * Per config the script prints the standard block (T1/T2/T4/verdict from
 * the consolidated engine) plus the §4.1 first-passage matrix: for both
 * stages, P(pass/breach/payout) and day-count percentiles over seeded
 * day-order reshuffles (same mulberry32 family as propViability).
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/sizeDownStudy.ts [--offline] [--max N] [--iters 2000] \
 *     [--split 2026-01-01] [--budget 50] [--cap 5] [--target 200] \
 *     [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import {
  scoreTrade,
  scoreSequential,
  coreStats,
  propViability,
  wilson95,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  type EngineTrade,
} from "../lib/backtestEngine";
import { dollarize, simulateAccount, type DollarizedTrade } from "../lib/propAccount";
import { RAPID_EOD_50K, momentumSize, type PropRules } from "../lib/propRules";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const POINT_VALUE = 2; // MNQ $2/pt
const PROD_BUDGET = 100; // PROP_RISK_PER_TRADE (lib/propRules.ts)
const PROD_MAX_MICRO = 30; // RAPID_EOD_50K.maxMicro
const COMM_PER_SIDE = 0.95; // $0.95/side — reported as a haircut note, not in the sims (engine-consistent)

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { offline: boolean; max?: number; iters: number; split: string; budget: number; cap: number; target: number; dump?: string } = {
    offline: false,
    iters: 2000,
    split: "2026-01-01",
    budget: 50,
    cap: 5,
    target: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline") o.offline = true;
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--iters") o.iters = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--budget") o.budget = Number(argv[++i]);
    else if (a === "--cap") o.cap = Number(argv[++i]);
    else if (a === "--target") o.target = Number(argv[++i]);
    else if (a === "--dump") o.dump = argv[++i];
  }
  return o;
}

/* ---------------- trade scoring (engine canonical) ---------------- */

type ScoredSignal = MomentumSignal & { date: string; exit: number; pnl: number; hit: "target" | "stop" | "time"; heldBars: number };

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string): ScoredSignal | null {
  const sc = scoreTrade(
    minutes,
    { dir: sig.dir === "long" ? 1 : -1, entry: sig.entry, stop: sig.stop, target: sig.target, entryIdx: sig.entryIdx, risk: sig.risk },
    { costPts: COST_PTS, holdBars: HOLD_BARS },
  );
  if (!sc) return null;
  return { ...sig, date, exit: sc.exit, pnl: sc.pnl, hit: sc.hit, heldBars: sc.heldBars };
}

/* ---------------- sizing configs ---------------- */

/** the $50 hard ceiling: a trade whose stop would risk > budget even at
 *  1 contract (risk > budget ÷ pointValue) cannot be taken at all. */
function tradeable(trades: EngineTrade[], budget: number): EngineTrade[] {
  return trades.filter((t) => t.risk <= budget / POINT_VALUE);
}

/** daily profit arm: once a day's cumulative P&L reaches `target`, skip
 *  every later trade that day (the trade that crosses it counts). */
function applyDailyTarget(dollars: DollarizedTrade[], target: number): { kept: DollarizedTrade[]; haltedDays: number; skipped: number } {
  const sorted = [...dollars].sort((a, b) => a.date.localeCompare(b.date));
  const kept: DollarizedTrade[] = [];
  const dayPnl = new Map<string, number>();
  const triggered = new Set<string>();
  let skipped = 0;
  for (const t of sorted) {
    if ((dayPnl.get(t.date) ?? 0) >= target) {
      triggered.add(t.date);
      skipped++;
      continue;
    }
    kept.push(t);
    dayPnl.set(t.date, (dayPnl.get(t.date) ?? 0) + t.pnl);
  }
  return { kept, haltedDays: triggered.size, skipped };
}

/** dollars per trade under a budget + contract cap (mirrors dollarize). */
function sizeUsd(t: EngineTrade, budget: number, cap: number): number {
  const s = momentumSize(t.risk, budget, { maxMicro: cap, pointValue: POINT_VALUE });
  return Math.round(t.pnl * POINT_VALUE * s.contracts * 100) / 100;
}

/* ---------------- first-passage bootstrap (§4.1) ---------------- */

/** seeded deterministic RNG (mulberry32) — same family as the engine lab */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pctl(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const a = [...sorted].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
  return a[idx];
}

type Boot = {
  iters: number;
  evalPass: number;
  evalBreach: number;
  evalUndecided: number;
  daysToPass: number[];
  daysToEvalBreach: number[];
  fundBreach: number;
  fundPayout: number;
  daysToPayout: number[];
  daysToFundBreach: number[];
  payoutsNoBreach: number[];
};

/** day-order reshuffles of the daily P&L series through BOTH stages.
 *  day index of pass/breach/payout comes from sim.days replay order. */
function bootstrap(daily: number[], rules: PropRules, iters: number, seed: number): Boot {
  const rand = mulberry32(seed);
  const b: Boot = {
    iters,
    evalPass: 0,
    evalBreach: 0,
    evalUndecided: 0,
    daysToPass: [],
    daysToEvalBreach: [],
    fundBreach: 0,
    fundPayout: 0,
    daysToPayout: [],
    daysToFundBreach: [],
    payoutsNoBreach: [],
  };
  for (let it = 0; it < iters; it++) {
    const shuffled = [...daily];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const rows = shuffled.map((pnl, i) => ({ date: `d${String(i).padStart(4, "0")}`, pnl }));
    const ev = simulateAccount(rows, "eval", 0, rules);
    // first-passage semantics (mirrors propViability): the eval ends at the
    // pass, so pass-then-breach counts as a pass — recover it from the
    // prefix before the breach day.
    let passAt: number | null = null;
    if (ev.passDay) {
      const idx = ev.days.findIndex((d) => d.date === ev.passDay);
      passAt = idx >= 0 ? idx + 1 : null;
    } else if (ev.breachDay) {
      const bi = ev.days.findIndex((d) => d.date === ev.breachDay);
      if (bi > 0) {
        const pre = simulateAccount(rows.slice(0, bi), "eval", 0, rules);
        if (pre.passDay) {
          const idx = pre.days.findIndex((d) => d.date === pre.passDay);
          passAt = idx >= 0 ? idx + 1 : null;
        }
      }
    }
    if (passAt !== null) {
      b.evalPass++;
      b.daysToPass.push(passAt);
    } else if (ev.breachDay) {
      b.evalBreach++;
      b.daysToEvalBreach.push(ev.days.findIndex((d) => d.date === ev.breachDay) + 1);
    } else {
      b.evalUndecided++;
    }
    const fu = simulateAccount(rows, "funded", 0, rules);
    if (fu.breachDay) {
      // payout-before-breach: re-check the prefix before the breach day
      const bi = fu.days.findIndex((d) => d.date === fu.breachDay);
      if (bi > 0) {
        const pre = simulateAccount(rows.slice(0, bi), "funded", 0, rules);
        const payoutIdx = pre.days.findIndex((d) => d.equity >= rules.buffer);
        if (!pre.breachDay && payoutIdx >= 0) {
          b.fundPayout++;
          b.daysToPayout.push(payoutIdx + 1);
          b.payoutsNoBreach.push(pre.payouts);
        } else {
          b.fundBreach++;
          b.daysToFundBreach.push(bi + 1);
        }
      } else {
        b.fundBreach++;
        b.daysToFundBreach.push(bi + 1);
      }
    } else {
      const payoutIdx = fu.days.findIndex((d) => d.equity >= rules.buffer);
      if (payoutIdx >= 0) {
        b.fundPayout++;
        b.daysToPayout.push(payoutIdx + 1);
        b.payoutsNoBreach.push(fu.payouts);
      }
    }
  }
  return b;
}

function dailySeries(dollars: DollarizedTrade[]): number[] {
  const byDate = new Map<string, number>();
  for (const t of dollars) byDate.set(t.date, (byDate.get(t.date) ?? 0) + t.pnl);
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/* ---------------- main ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  const rules5: PropRules = { ...RAPID_EOD_50K, maxMicro: o.cap };

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`size-down study · ${dates.length} sessions · split ${o.split} · iters ${o.iters} · config: cap ${o.cap} · $${o.budget} risk · +$${o.target}/day halt`);
  const t0 = Date.now();

  /* ---- production point stream (MOM_PROD + EXP_PROD, sequential) ---- */
  const stream: ScoredSignal[] = [];
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      const sigs = [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)].sort((a, b) => a.entryIdx - b.entryIdx);
      stream.push(...scoreSequential(sigs, (s) => scoreSignal(minutes, s, date)));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions · ${failed} failed · ${stream.length} sequential trades\n`);

  const prod = stream.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  const tradeable = prod.filter((t) => t.risk <= o.budget / POINT_VALUE);

  /* ---- the three configs, dollarized ---- */
  const c1 = dollarize(prod.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })), PROD_BUDGET, { maxMicro: PROD_MAX_MICRO, pointValue: POINT_VALUE });
  const c2 = dollarize(tradeable.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })), o.budget, { maxMicro: o.cap, pointValue: POINT_VALUE });
  const halt = applyDailyTarget(c2, o.target);
  const c3 = halt.kept;
  const haltedPts = c3.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));

  console.log(`config streams: prod n=${prod.length} · tradeable(≤${o.budget / POINT_VALUE}pt) n=${tradeable.length} · +$${o.target}/day halt kept n=${haltedPts.length} (${halt.skipped} trades skipped, ${halt.haltedDays} days halted)`);
  const skippedWide = prod.length - tradeable.length;
  if (skippedWide) console.log(`  skipped ${skippedWide} trades with stop > ${o.budget / POINT_VALUE} pts (would risk > $${o.budget} at 1 contract)`);

  /* ---- T1 core quality (points; the edge itself does not change with sizing) ---- */
  console.log("\n=== T1 — core quality (points, sizing-independent; halt row drops the skipped trades) ===");
  console.log(
    renderT1([
      { label: "prod stream all", stats: coreStats(prod) },
      { label: "train", stats: coreStats(prod.filter((t) => t.date < o.split)) },
      { label: "test", stats: coreStats(prod.filter((t) => t.date >= o.split)) },
      { label: `tradeable ≤${o.budget / POINT_VALUE}pt`, stats: coreStats(tradeable) },
      { label: `halted (+$${o.target}/day)`, stats: coreStats(haltedPts) },
    ]),
  );

  console.log("\n=== T2 — point-stream cohorts (the cost of each rule in trades/pts) ===");
  console.log(
    renderT2(
      [
        { label: "prod stream", trades: prod },
        { label: `tradeable ≤${o.budget / POINT_VALUE}pt`, trades: tradeable },
        { label: `halted (+$${o.target}/day)`, trades: haltedPts },
      ].map((r) => {
        const s = coreStats(r.trades);
        const tr = coreStats(r.trades.filter((t) => t.date < o.split));
        const te = coreStats(r.trades.filter((t) => t.date >= o.split));
        return {
          rule: r.label,
          n: s.n,
          wr: s.wr,
          ci: wilson95(s.wins, s.n),
          pf: s.pf,
          expPts: s.expPts,
          trainTest: `${tr.wr.toFixed(1)}% / ${te.wr.toFixed(1)}%`,
          compare:
            r.label === "prod stream"
              ? "—"
              : `full prod stream ${coreStats(prod).n} trades · WR ${coreStats(prod).wr.toFixed(1)}% · net ${coreStats(prod).netPts.toFixed(0)} pts`,
        };
      }),
    ),
  );

  /* ---- T4 per config (engine viability) + §4.1 first-passage matrix ---- */
  const configs = [
    { name: `prod $${PROD_BUDGET}/${PROD_MAX_MICRO}µ (baseline)`, trades: prod, budget: PROD_BUDGET, rules: RAPID_EOD_50K, dollars: c1 },
    { name: `cap ${o.cap} · $${o.budget} risk`, trades: tradeable, budget: o.budget, rules: rules5, dollars: c2 },
    { name: `cap ${o.cap} · $${o.budget} · +$${o.target}/day`, trades: haltedPts, budget: o.budget, rules: rules5, dollars: c3 },
  ];

  console.log("\n=== T4 — prop-account viability (one block per config) ===");
  const matrix: Record<string, unknown> = {};
  for (const c of configs) {
    console.log(`\n--- ${c.name} ---`);
    const v = propViability(c.trades, { splitDate: o.split, rules: c.rules, iters: o.iters, budget: c.budget });
    console.log(renderT4(v));

    const daily = dailySeries(c.dollars);
    const b = bootstrap(daily, c.rules, o.iters, 0x5eed);
    const total = daily.reduce((a, x) => a + x, 0);
    const worstDay = Math.min(...daily);
    const bestDay = Math.max(...daily);
    const avgDay = mean(daily);
    const comm = c.trades.length * 2 * COMM_PER_SIDE;

    // day-shape diagnostics: how thin is the tail the MLL has to survive?
    const lossDays = daily.filter((x) => x < 0);
    let maxRun = 0;
    let run = 0;
    for (const x of daily) {
      run = x < 0 ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    const daySd = Math.sqrt(mean(daily.map((x) => (x - avgDay) ** 2)));

    console.log(`daily P&L: total $${total.toFixed(0)} · mean $${avgDay.toFixed(0)} · best $${bestDay.toFixed(0)} · worst $${worstDay.toFixed(0)} · sessions ${daily.length}`);
    console.log(
      `day shape: sd $${daySd.toFixed(0)} · losing days ${lossDays.length}/${daily.length} (${((lossDays.length / daily.length) * 100).toFixed(1)}%) · mean loss $${mean(lossDays).toFixed(0)} · longest losing run ${maxRun} days`,
    );
    console.log(
      `§4.1 eval   P(pass)=${((b.evalPass / b.iters) * 100).toFixed(1)}% · P(breach)=${((b.evalBreach / b.iters) * 100).toFixed(1)}% · undecided ${b.evalUndecided}` +
        ` · days→pass med ${pctl(b.daysToPass, 0.5)} [p10 ${pctl(b.daysToPass, 0.1)}–p90 ${pctl(b.daysToPass, 0.9)}]` +
        (b.daysToEvalBreach.length ? ` · days→breach med ${pctl(b.daysToEvalBreach, 0.5)}` : ""),
    );
    console.log(
      `§4.1 funded P(breach)=${((b.fundBreach / b.iters) * 100).toFixed(1)}% · P(first payout)=${((b.fundPayout / b.iters) * 100).toFixed(1)}%` +
        ` · days→payout med ${pctl(b.daysToPayout, 0.5)} [p10 ${pctl(b.daysToPayout, 0.1)}–p90 ${pctl(b.daysToPayout, 0.9)}]` +
        (b.daysToFundBreach.length ? ` · days→breach med ${pctl(b.daysToFundBreach, 0.5)}` : "") +
        (b.payoutsNoBreach.length ? ` · payouts med ${pctl(b.payoutsNoBreach, 0.5)} (no-breach paths)` : ""),
    );
    console.log(`sizing: maxDD $${v.maxDdUsd.toFixed(0)} = ${(v.mllRatio * 100).toFixed(0)}% of $${c.rules.maxLoss} MLL · commissions ≈ $${comm.toFixed(0)} RT (not in sim)`);
    console.log(`naive days→$3,000 ≈ ${avgDay > 0 ? Math.max(4, Math.ceil(c.rules.profitTarget / avgDay)) : "—"} (ignores path, DD and gates)`);

    matrix[c.name] = {
      nTrades: c.trades.length,
      total,
      avgDay: Math.round(avgDay),
      bestDay: Math.round(bestDay),
      worstDay: Math.round(worstDay),
      maxDdUsd: v.maxDdUsd,
      mllRatio: v.mllRatio,
      evalPassPct: Math.round((b.evalPass / b.iters) * 1000) / 10,
      evalBreachPct: Math.round((b.evalBreach / b.iters) * 1000) / 10,
      evalUndecided: b.evalUndecided,
      daysToPassP10: pctl(b.daysToPass, 0.1),
      daysToPassP50: pctl(b.daysToPass, 0.5),
      daysToPassP90: pctl(b.daysToPass, 0.9),
      fundBreachPct: Math.round((b.fundBreach / b.iters) * 1000) / 10,
      fundPayoutPct: Math.round((b.fundPayout / b.iters) * 1000) / 10,
      daysToPayoutP10: pctl(b.daysToPayout, 0.1),
      daysToPayoutP50: pctl(b.daysToPayout, 0.5),
      daysToPayoutP90: pctl(b.daysToPayout, 0.9),
      payoutsMed: pctl(b.payoutsNoBreach, 0.5),
      chronoEval: v.evalSim,
      chronoFunded: v.fundedSim,
      haltedDays: c.name.includes("+$") ? halt.haltedDays : 0,
      skippedTrades: c.name.includes("+$") ? halt.skipped : 0,
    };
  }

  /* ---- the §4.1 comparison matrix (the direct answer) ---- */
  console.log("\n=== §4.1 first-passage matrix — P(breach) vs time-to-pass ===");
  console.log("| config | n trades | total $ | mean day | worst day | P(eval pass) | P(eval breach) | days→pass med [p10–p90] | P(fund breach) | P(1st payout) | days→payout med | payouts med | maxDD$ ÷ MLL |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, m] of Object.entries(matrix)) {
    const x = m as Record<string, number>;
    console.log(
      `| ${name} | ${x.nTrades} | $${Math.round(x.total)} | $${x.avgDay} | $${x.worstDay} | ${x.evalPassPct}% | ${x.evalBreachPct}% | ` +
        `${x.daysToPassP50} [${x.daysToPassP10}–${x.daysToPassP90}] | ${x.fundBreachPct}% | ${x.fundPayoutPct}% | ${x.daysToPayoutP50} | ${x.payoutsMed} | $${Math.round(x.maxDdUsd)} (${Math.round(x.mllRatio * 100)}%) |`,
    );
  }

  /* ---- verification bootstrap: the 0%-breach claim at a different seed
   *      and 10k iterations (the tail is thin; prove it is not a seed) ---- */
  {
    const c = configs[2];
    const daily = dailySeries(c.dollars);
    const b = bootstrap(daily, c.rules, 10000, 0xbadc0de);
    console.log(
      `\n=== verification (${c.name} · 10,000 iters · seed 0xBADCODE) ===\n` +
        `P(eval pass)=${((b.evalPass / b.iters) * 100).toFixed(2)}% · P(eval breach)=${((b.evalBreach / b.iters) * 100).toFixed(2)}% · ` +
        `P(fund breach)=${((b.fundBreach / b.iters) * 100).toFixed(2)}% · P(first payout)=${((b.fundPayout / b.iters) * 100).toFixed(2)}% · ` +
        `days→pass med ${pctl(b.daysToPass, 0.5)} [p10 ${pctl(b.daysToPass, 0.1)}–p90 ${pctl(b.daysToPass, 0.9)}] · days→payout med ${pctl(b.daysToPayout, 0.5)} [p10 ${pctl(b.daysToPayout, 0.1)}–p90 ${pctl(b.daysToPayout, 0.9)}]`,
    );
  }

  /* ---- verdict for the proposed config ---- */
  const proposal = configs[2];
  const pv = propViability(proposal.trades, { splitDate: o.split, rules: proposal.rules, iters: o.iters, budget: proposal.budget });
  const testStats = coreStats(prod.filter((t) => t.date >= o.split));
  const trainStats = coreStats(prod.filter((t) => t.date < o.split));
  console.log(
    "\n" +
      renderVerdict({
        edge: testStats.netPts > 0 && testStats.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${Math.abs(trainStats.wr - testStats.wr).toFixed(1)} pts`,
        holdout: "n/a (validation pipeline)",
        viability:
          pv.pPass === null
            ? "n/a"
            : `${pv.pPass >= 0.9 ? "PASS" : pv.pPass >= 0.7 ? "weak" : "FAIL"} (P=${pv.pPass.toFixed(2)})`,
      }),
  );

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          args: { split: o.split, iters: o.iters, budget: o.budget, cap: o.cap, target: o.target },
          sessions: dates.length,
          nTrades: { prod: prod.length, tradeable: tradeable.length, halted: haltedPts.length },
          matrix,
        },
        null,
        1,
      ),
    );
    console.log(`\ndumped → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
