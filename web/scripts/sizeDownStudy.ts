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
 *     [--loss-floor 250] [--floor-sweep] [--dump out.json] \
 *     [--sweep] [--cell-iters 500]
 *
 * --sweep runs the risk-layer grid instead of the single-config report:
 * budget {25,40,50,60,75,100,125,150,200,250} × cap {2..30} × daily arm
 * {off,200,300,400} = 400 cells; each cell gets the same §4.1 bootstrap
 * (--cell-iters reshuffles, default 500) and the frontier printer lists
 * every cell with zero breaches and green-band drawdown, fastest first.
 *
 * --loss-floor L adds the loss side to the daily arm (halt new trades once
 * the day is ≤ −$L; the live guard's DAILY_LOSS_FLOOR default is 250).
 * --floor-sweep keeps the replay and sweeps floors {0,100,150,200,250,300,
 * 400} at the given budget/cap/target, printing the loss-floor dimension
 * table (worst day, mean day, pass time, breaches, halts per floor).
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
  const o: { offline: boolean; max?: number; iters: number; split: string; budget: number; cap: number; target: number; lossFloor: number; floorSweep: boolean; dump?: string; sweep: boolean; cellIters: number } = {
    offline: false,
    iters: 2000,
    split: "2026-01-01",
    budget: 50,
    cap: 5,
    target: 200,
    lossFloor: 0,
    floorSweep: false,
    sweep: false,
    cellIters: 500,
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
    else if (a === "--loss-floor") o.lossFloor = Number(argv[++i]);
    else if (a === "--floor-sweep") o.floorSweep = true;
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--sweep") o.sweep = true;
    else if (a === "--cell-iters") o.cellIters = Number(argv[++i]);
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

/** day halts, two-sided: once a day's cumulative P&L reaches +`target`
 *  (profit side) or −`lossFloor` (loss side), skip every later trade that
 *  day (the trade that crosses it counts). Zero = side off. */
function applyDailyTarget(dollars: DollarizedTrade[], target: number, lossFloor = 0): { kept: DollarizedTrade[]; haltedDays: number; skipped: number; lossDays: number } {
  const sorted = [...dollars].sort((a, b) => a.date.localeCompare(b.date));
  const kept: DollarizedTrade[] = [];
  const dayPnl = new Map<string, number>();
  const triggered = new Set<string>();
  const lossTriggered = new Set<string>();
  let skipped = 0;
  for (const t of sorted) {
    const d = dayPnl.get(t.date) ?? 0;
    if ((target > 0 && d >= target) || (lossFloor > 0 && d <= -lossFloor)) {
      triggered.add(t.date);
      if (lossFloor > 0 && d <= -lossFloor) lossTriggered.add(t.date);
      skipped++;
      continue;
    }
    kept.push(t);
    dayPnl.set(t.date, d + t.pnl);
  }
  return { kept, haltedDays: triggered.size, skipped, lossDays: lossTriggered.size };
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

/* ---------------- risk-layer grid sweep (--sweep) ---------------- */

type SweepCell = {
  budget: number;
  cap: number;
  target: number;
  n: number;
  meanDay: number;
  worstDay: number;
  bestDay: number;
  daySd: number;
  maxDdUsd: number;
  mllRatio: number;
  haltedDays: number;
  skipped: number;
  pEvalPass: number; // 0..1
  pEvalBreach: number;
  medPass: number | null;
  p10Pass: number | null;
  p90Pass: number | null;
  pFundBreach: number;
  pPayout: number;
  medPayout: number | null;
};

const SWEEP_BUDGETS = [25, 40, 50, 60, 75, 100, 125, 150, 200, 250];
const SWEEP_CAPS = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30];
const SWEEP_TARGETS = [0, 200, 300, 400]; // 0 = no daily arm

function maxDdUsd(trades: DollarizedTrade[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const d = peak - eq;
    if (d > dd) dd = d;
  }
  return dd;
}

async function runSweep(prod: EngineTrade[], o: { cellIters: number; dump?: string }): Promise<void> {
  console.log(`sweep: ${SWEEP_BUDGETS.length} budgets × ${SWEEP_CAPS.length} caps × ${SWEEP_TARGETS.length} targets = ${SWEEP_BUDGETS.length * SWEEP_CAPS.length * SWEEP_TARGETS.length} cells · ${o.cellIters} iters/cell`);
  const t0 = Date.now();
  const cells: SweepCell[] = [];
  for (const budget of SWEEP_BUDGETS) {
    // the hard dollar ceiling: skip stops that would risk > budget at 1 contract
    const tradeable = prod.filter((t) => t.risk <= budget / POINT_VALUE);
    for (const cap of SWEEP_CAPS) {
      const sized = dollarize(
        tradeable.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })),
        budget,
        { maxMicro: cap, pointValue: POINT_VALUE },
      );
      for (const target of SWEEP_TARGETS) {
        const arm = target > 0 ? applyDailyTarget(sized, target) : { kept: sized, haltedDays: 0, skipped: 0 };
        const daily = dailySeries(arm.kept);
        const b = bootstrap(daily, RAPID_EOD_50K, o.cellIters, 0x5eed);
        const dd = maxDdUsd(arm.kept);
        const meanDay = mean(daily);
        cells.push({
          budget,
          cap,
          target,
          n: arm.kept.length,
          meanDay: Math.round(meanDay),
          worstDay: Math.round(Math.min(...daily)),
          bestDay: Math.round(Math.max(...daily)),
          daySd: Math.round(Math.sqrt(mean(daily.map((x) => (x - meanDay) ** 2)))),
          maxDdUsd: dd,
          mllRatio: dd / RAPID_EOD_50K.maxLoss,
          haltedDays: arm.haltedDays,
          skipped: arm.skipped,
          pEvalPass: b.evalPass / b.iters,
          pEvalBreach: b.evalBreach / b.iters,
          medPass: pctl(b.daysToPass, 0.5),
          p10Pass: pctl(b.daysToPass, 0.1),
          p90Pass: pctl(b.daysToPass, 0.9),
          pFundBreach: b.fundBreach / b.iters,
          pPayout: b.fundPayout / b.iters,
          medPayout: pctl(b.daysToPayout, 0.5),
        });
      }
    }
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${cells.length} cells swept\n`);

  const fmt = (c: SweepCell): string =>
    `b$${String(c.budget).padStart(3)} cap${String(c.cap).padStart(2)} t${c.target === 0 ? "off" : String(c.target).padStart(3)} | n ${String(c.n).padStart(4)} | day $${String(c.meanDay).padStart(4)} | worst $${String(c.worstDay).padStart(4)} | dd ${(c.mllRatio * 100).toFixed(0).padStart(3)}% | P(eB) ${(c.pEvalBreach * 100).toFixed(1).padStart(5)}% | pass ${String(c.medPass ?? "—").padStart(3)}d [${c.p10Pass ?? "—"}–${c.p90Pass ?? "—"}] | P(fB) ${(c.pFundBreach * 100).toFixed(1).padStart(5)}% | payout ${String(c.medPayout ?? "—").padStart(3)}d | halts ${c.haltedDays}`;

  const safe = (c: SweepCell): boolean => c.pEvalBreach === 0 && c.pFundBreach === 0 && c.mllRatio <= 0.4;
  const byPass = (a: SweepCell, b: SweepCell): number => (a.medPass ?? 1e9) - (b.medPass ?? 1e9) || a.mllRatio - b.mllRatio;

  const safeCells = cells.filter(safe).sort(byPass);
  console.log(`SAFE FRONTIER — 0 breaches (both stages) AND maxDD ≤ 40% MLL — ${safeCells.length} cells, fastest first:`);
  for (const c of safeCells.slice(0, 40)) console.log("  " + fmt(c));
  if (safeCells.length > 40) console.log(`  … ${safeCells.length - 40} more`);
  if (!safeCells.length) console.log("  (none — loosen the band or the data says no cell is safe)");

  const anyCells = [...cells].sort(byPass).slice(0, 8);
  console.log("\nfastest overall (regardless of breach — the risky extreme, for contrast):");
  for (const c of anyCells) console.log("  " + fmt(c));

  /* ---- verification: top safe cell + the cap5/$50/$200 proposal, 10k iters ---- */
  const top = safeCells[0];
  const proposalCell = cells.find((c) => c.budget === 50 && c.cap === 5 && c.target === 200);
  for (const [label, c] of [["top safe cell", top], ["cap5/$50/$200 (prior study)", proposalCell]] as Array<[string, SweepCell | undefined]>) {
    if (!c) continue;
    const sized = dollarize(
      prod.filter((t) => t.risk <= c.budget / POINT_VALUE).map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })),
      c.budget,
      { maxMicro: c.cap, pointValue: POINT_VALUE },
    );
    const arm = c.target > 0 ? applyDailyTarget(sized, c.target) : null;
    const daily = dailySeries(arm ? arm.kept : sized);
    const b = bootstrap(daily, RAPID_EOD_50K, 10000, 0xbadc0de);
    console.log(
      `\nverify ${label}: b$${c.budget} cap${c.cap} t${c.target === 0 ? "off" : c.target} · 10,000 iters · ` +
        `P(eval pass)=${((b.evalPass / b.iters) * 100).toFixed(2)}% · P(eval breach)=${((b.evalBreach / b.iters) * 100).toFixed(2)}% · ` +
        `P(fund breach)=${((b.fundBreach / b.iters) * 100).toFixed(2)}% · P(1st payout)=${((b.fundPayout / b.iters) * 100).toFixed(2)}% · ` +
        `days→pass med ${pctl(b.daysToPass, 0.5)} [p10 ${pctl(b.daysToPass, 0.1)}–p90 ${pctl(b.daysToPass, 0.9)}] · days→payout med ${pctl(b.daysToPayout, 0.5)}`,
    );
  }

  if (o.dump) {
    await fs.writeFile(o.dump, JSON.stringify({ generated: new Date().toISOString(), cellIters: o.cellIters, cells }, null, 1));
    console.log(`\ndumped → ${o.dump}`);
  }
}

/* ---------------- loss-floor sweep (--floor-sweep) ---------------- */

const FLOORS = [0, 100, 150, 200, 250, 300, 400];

async function runFloorSweep(prod: EngineTrade[], o: { budget: number; cap: number; target: number; dump?: string }): Promise<void> {
  const rules: PropRules = { ...RAPID_EOD_50K, maxMicro: o.cap };
  const tradeable = prod.filter((t) => t.risk <= o.budget / POINT_VALUE);
  const sized = dollarize(
    tradeable.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })),
    o.budget,
    { maxMicro: o.cap, pointValue: POINT_VALUE },
  );
  console.log(`loss-floor sweep: b$${o.budget} · cap ${o.cap} · profit arm +$${o.target || "off"} · floors ${FLOORS.join("/")} · 1,000 iters/floor`);
  const t0 = Date.now();
  const rows: Record<string, unknown>[] = [];
  for (const floor of FLOORS) {
    const arm = applyDailyTarget(sized, o.target, floor);
    const daily = dailySeries(arm.kept);
    const b = bootstrap(daily, rules, 1000, 0x5eed);
    const dd = maxDdUsd(arm.kept);
    const ev = simulateAccount(arm.kept.map((t) => ({ date: t.date, pnl: t.pnl })), "eval", 0, rules);
    rows.push({
      floor,
      n: arm.kept.length,
      worstDay: Math.round(Math.min(...daily)),
      meanDay: Math.round(mean(daily)),
      bestDay: Math.round(Math.max(...daily)),
      medPass: pctl(b.daysToPass, 0.5),
      p10Pass: pctl(b.daysToPass, 0.1),
      p90Pass: pctl(b.daysToPass, 0.9),
      pEvalBreach: b.evalBreach / b.iters,
      pFundBreach: b.fundBreach / b.iters,
      ddRatio: dd / RAPID_EOD_50K.maxLoss,
      lossHalts: arm.lossDays,
      profitHalts: arm.haltedDays - arm.lossDays,
      medPayout: pctl(b.daysToPayout, 0.5),
      chronoPassDay: ev.passDay,
      chronoBreach: ev.breachDay,
    });
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  console.log("| loss floor | n trades | worst day | mean day | best day | P(eval breach) | P(fund breach) | pass med [p10–p90] | payout med | maxDD ÷ MLL | loss-halts | profit-halts | chrono pass |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const x = r as Record<string, number | string>;
    console.log(
      `| ${x.floor === 0 ? "off" : "$" + x.floor} | ${x.n} | $${x.worstDay} | $${x.meanDay} | $${x.bestDay} | ${((x.pEvalBreach as number) * 100).toFixed(1)}% | ${((x.pFundBreach as number) * 100).toFixed(1)}% | ` +
        `${x.medPass} [${x.p10Pass}–${x.p90Pass}] | ${x.medPayout} | $${Math.round((x.ddRatio as number) * 2000)} (${Math.round((x.ddRatio as number) * 100)}%) | ${x.lossHalts} | ${x.profitHalts} | ${x.chronoPassDay ?? (x.chronoBreach ? "BREACH " + x.chronoBreach : "—")} |`,
    );
  }
  // verification: the live default floor (250) at 10k iters, different seed
  const arm250 = applyDailyTarget(sized, o.target, 250);
  const b250 = bootstrap(dailySeries(arm250.kept), rules, 10000, 0xbadc0de);
  console.log(
    `\nverify floor $250 (live DAILY_LOSS_FLOOR default) · 10,000 iters · P(eval pass)=${((b250.evalPass / b250.iters) * 100).toFixed(2)}% · ` +
      `P(eval breach)=${((b250.evalBreach / b250.iters) * 100).toFixed(2)}% · P(fund breach)=${((b250.fundBreach / b250.iters) * 100).toFixed(2)}% · ` +
      `P(1st payout)=${((b250.fundPayout / b250.iters) * 100).toFixed(2)}% · days→pass med ${pctl(b250.daysToPass, 0.5)} [p10 ${pctl(b250.daysToPass, 0.1)}–p90 ${pctl(b250.daysToPass, 0.9)}]`,
  );
  if (o.dump) {
    await fs.writeFile(o.dump, JSON.stringify({ generated: new Date().toISOString(), config: { budget: o.budget, cap: o.cap, target: o.target }, floors: rows }, null, 1));
    console.log(`\ndumped → ${o.dump}`);
  }
}

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

  /* ---- sweep mode: the risk-layer grid ---- */
  if (o.sweep) {
    await runSweep(prod, { cellIters: o.cellIters, dump: o.dump });
    return;
  }

  /* ---- floor-sweep mode: the daily-loss-floor dimension ---- */
  if (o.floorSweep) {
    await runFloorSweep(prod, { budget: o.budget, cap: o.cap, target: o.target, dump: o.dump });
    return;
  }

  /* ---- the configs, dollarized ---- */
  const c1 = dollarize(prod.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })), PROD_BUDGET, { maxMicro: PROD_MAX_MICRO, pointValue: POINT_VALUE });
  const c2 = dollarize(tradeable.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })), o.budget, { maxMicro: o.cap, pointValue: POINT_VALUE });
  const arm = o.target > 0 || o.lossFloor > 0 ? applyDailyTarget(c2, o.target, o.lossFloor) : { kept: c2, haltedDays: 0, skipped: 0, lossDays: 0 };
  const c3 = arm.kept;
  const haltedPts = c3.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));

  console.log(
    `config streams: prod n=${prod.length} · tradeable(≤${o.budget / POINT_VALUE}pt) n=${tradeable.length}` +
      (o.target > 0 ? ` · +$${o.target}/day halt kept n=${haltedPts.length} (${arm.skipped} trades skipped, ${arm.haltedDays} days halted)` : " · no daily arm"),
  );
  const skippedWide = prod.length - tradeable.length;
  if (skippedWide) console.log(`  skipped ${skippedWide} trades with stop > ${o.budget / POINT_VALUE} pts (would risk > $${o.budget} at 1 contract)`);

  /* ---- T1 core quality (points; the edge itself does not change with sizing) ---- */
  console.log("\n=== T1 — core quality (points, sizing-independent; halt row drops the skipped trades) ===");
  const t1Rows = [
    { label: "prod stream all", stats: coreStats(prod) },
    { label: "train", stats: coreStats(prod.filter((t) => t.date < o.split)) },
    { label: "test", stats: coreStats(prod.filter((t) => t.date >= o.split)) },
    { label: `tradeable ≤${o.budget / POINT_VALUE}pt`, stats: coreStats(tradeable) },
  ];
  if (o.target > 0) t1Rows.push({ label: `halted (+$${o.target}/day)`, stats: coreStats(haltedPts) });
  console.log(renderT1(t1Rows));

  console.log("\n=== T2 — point-stream cohorts (the cost of each rule in trades/pts) ===");
  const t2Cohorts = [
    { label: "prod stream", trades: prod },
    { label: `tradeable ≤${o.budget / POINT_VALUE}pt`, trades: tradeable },
  ];
  if (o.target > 0) t2Cohorts.push({ label: `halted (+$${o.target}/day)`, trades: haltedPts });
  console.log(
    renderT2(
      t2Cohorts.map((r) => {
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
  ];
  if (o.target > 0) configs.push({ name: `cap ${o.cap} · $${o.budget} · +$${o.target}/day`, trades: haltedPts, budget: o.budget, rules: rules5, dollars: c3 });

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
      haltedDays: c.name.includes("+$") ? arm.haltedDays : 0,
      skippedTrades: c.name.includes("+$") ? arm.skipped : 0,
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
    const c = configs[configs.length - 1];
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
  const proposal = configs[configs.length - 1];
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
