/* ------------------------------------------------------------------ *
 * Runner study — every production strategy re-scored with the ladder
 * exit (web/lib/runner.ts): open target, stop → BE at +1R, → +1R at
 * +2R, → +2R at +3R, …, 60-minute time exit.
 *
 * Grounded in MyFundedFutures Rapid EOD 50k: per-family trades are
 * dollarized at the live sizing (9 MNQ fixed for momentum/expansion/
 * RTH, $170-budget sizing for the open drive) and replayed through
 * simulateAccount (EOD-trailing $2,000 MLL, $100 lock, 30% consistency,
 * $2,100 buffer / $500 payouts) — eval and funded — plus the day-P&L
 * distribution (median, worst, P(day ≥ $500), P(day ≥ $900)).
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/runnerStudy.ts [--family momentum|expansion|rth|open|all] \
 *     [--max N] [--offline] [--maxBars 60]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { scoreRunner, type RunnerTrade } from "../lib/runner";
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
const FIXED_MICROS = 9; // live default for momentum/expansion/RTH
const POINT_VALUE = 2; // $2/pt MNQ
const DAY_GOALS = [500, 900];

type FamilyDef = {
  name: string;
  detect: (m: MomMinute[]) => MomentumSignal[];
  fixedSize: boolean;
};

const FAMILIES: FamilyDef[] = [
  { name: "momentum", detect: (m) => [...detectMomentum(m, MOM_PROD), ...detectExpansionScalp(m, EXP_PROD)], fixedSize: true },
  { name: "expansion", detect: (m) => detectExpansionScalp(m, EXP_PROD), fixedSize: true },
  { name: "rth", detect: (m) => detectSoftMomentum(m, SOFT_PROD), fixedSize: true },
  { name: "open", detect: (m) => detectOpenDrive(m, OPEN_PROD), fixedSize: false },
];

function parseArgs(argv: string[]) {
  const o: { family: string; max?: number; offline: boolean; maxBars: number } = {
    family: "all",
    offline: false,
    maxBars: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--family") o.family = argv[++i];
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--offline") o.offline = true;
    else if (a === "--maxBars") o.maxBars = Number(argv[++i]);
  }
  return o;
}

function sequentialize(minutes: MomMinute[], signals: MomentumSignal[], maxBars: number): RunnerTrade[] {
  const out: RunnerTrade[] = [];
  let openUntil = -1;
  // detectors return separate lists — merge in strict time order so the
  // one-trade-at-a-time rule matches what a live trader actually faces
  const ordered = [...signals].sort((a, b) => a.entryIdx - b.entryIdx);
  for (const s of ordered) {
    if (s.entryIdx <= openUntil) continue; // the live trader cannot be in two trades
    const dir = s.dir === "long" ? 1 : -1;
    const t = scoreRunner(minutes, s.entry, s.stop, dir, s.entryIdx, { maxBars });
    if (!t) continue;
    out.push(t);
    openUntil = s.entryIdx + t.heldBars;
  }
  return out;
}

type FamStats = {
  name: string;
  trades: RunnerTrade[];
  n: number;
  wr: number;
  pf: number;
  avgPts: number;
  expR: number;
  avgExitR: number;
  fullLossPct: number;
  bePct: number;
  partialPct: number;
  ge1RPct: number;
  ge2RPct: number;
  ge3RPct: number;
  timePct: number;
  ambPct: number;
  mfeR: number;
  maeR: number;
  maxFavorR: number;
  avgHeld: number;
  netPts: number;
  sessions: number;
};

function famStats(name: string, trades: { t: RunnerTrade; date: string }[]): FamStats {
  const rs = trades.map((x) => x.t);
  const n = rs.length;
  const wins = rs.filter((t) => t.pnl > 0);
  const losses = rs.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = rs.reduce((a, t) => a + t.pnl, 0);
  const pct = (f: (t: RunnerTrade) => boolean) => (n ? (rs.filter(f).length / n) * 100 : 0);
  return {
    name,
    trades: rs,
    n,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgPts: n ? net / n : 0,
    expR: n ? rs.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0,
    avgExitR: n ? rs.reduce((a, t) => a + t.exitR, 0) / n : 0,
    fullLossPct: pct((t) => t.exitR <= -0.999),
    bePct: pct((t) => t.exitR === 0),
    partialPct: pct((t) => t.exitR > 0 && t.exitR < 1),
    ge1RPct: pct((t) => t.exitR >= 1),
    ge2RPct: pct((t) => t.exitR >= 2),
    ge3RPct: pct((t) => t.exitR >= 3),
    timePct: pct((t) => t.hit === "time"),
    ambPct: pct((t) => t.ambiguous),
    mfeR: n ? rs.reduce((a, t) => a + t.mfeR, 0) / n : 0,
    maeR: n ? rs.reduce((a, t) => a + t.maeR, 0) / n : 0,
    maxFavorR: n ? rs.reduce((a, t) => a + t.maxFavorR, 0) / n : 0,
    avgHeld: n ? rs.reduce((a, t) => a + t.heldBars, 0) / n : 0,
    netPts: net,
    sessions: new Set(trades.map((x) => x.date)).size,
  };
}

function fmtFam(s: FamStats): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return (
    `${s.name.padEnd(10)} n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} ` +
    `avgPts=${s.avgPts.toFixed(2).padStart(6)} expR=${s.expR.toFixed(2).padStart(5)} avgExitR=${s.avgExitR.toFixed(2).padStart(5)} ` +
    `loss=${s.fullLossPct.toFixed(0).padStart(3)}% be=${s.bePct.toFixed(0).padStart(3)}% part=${s.partialPct.toFixed(0).padStart(3)}% ` +
    `ge1R=${s.ge1RPct.toFixed(0).padStart(3)}% ge2R=${s.ge2RPct.toFixed(0).padStart(3)}% ge3R=${s.ge3RPct.toFixed(0).padStart(3)}% ` +
    `time=${s.timePct.toFixed(0).padStart(3)}% amb=${s.ambPct.toFixed(0).padStart(2)}% ` +
    `mfeR=${s.mfeR.toFixed(2)} maeR=${s.maeR.toFixed(2)} held=${s.avgHeld.toFixed(0).padStart(2)}m ` +
    `net=${s.netPts.toFixed(0).padStart(6)}pts sess=${s.sessions}`
  );
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  const families = FAMILIES.filter((f) => o.family === "all" || f.name === o.family);
  console.log(`runner ladder study · ${dates.length} sessions · families: ${families.map((f) => f.name).join(", ")} · maxBars ${o.maxBars}`);
  const t0 = Date.now();

  const perFamily: { def: FamilyDef; trades: { t: RunnerTrade; date: string }[] }[] = families.map((def) => ({
    def,
    trades: [],
  }));

  let loaded = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      for (const fam of perFamily) {
        const signals = fam.def.detect(minutes);
        const scored = sequentialize(minutes, signals, o.maxBars);
        for (const t of scored) fam.trades.push({ t, date });
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }

  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);
  console.log("POINT-LEVEL (ladder exit, 0.5 pt cost, pessimistic same-bar, sequential)");
  for (const fam of perFamily) {
    const s = famStats(fam.def.name, fam.trades);
    console.log("  " + fmtFam(s));
  }

  console.log("\nMFF RAPID EOD 50k (sizing: 9 MNQ fixed · open drive $170-budget)");
  for (const fam of perFamily) {
    const raw = fam.trades.map(({ t, date }) => ({ date, pnlPts: t.pnl, riskPts: t.risk }));
    if (!raw.length) {
      console.log(`  ${fam.def.name.padEnd(10)} no trades`);
      continue;
    }
    const sized = fam.def.fixedSize
      ? raw.map((x) => ({ ...x, contracts: FIXED_MICROS, pnl: Math.round(x.pnlPts * POINT_VALUE * FIXED_MICROS * 100) / 100 }))
      : dollarize(raw);
    const dayPnl = new Map<string, number>();
    for (const x of sized) dayPnl.set(x.date, (dayPnl.get(x.date) ?? 0) + x.pnl);
    const days = [...dayPnl.values()];
    const sorted = [...days].sort((a, b) => a - b);
    const med = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : 0);
    const evalSim = simulateAccount(sized.map((x) => ({ date: x.date, pnl: x.pnl })), "eval");
    const funded = simulateAccount(sized.map((x) => ({ date: x.date, pnl: x.pnl })), "funded");
    const pGoal = (g: number) => (days.length ? ((days.filter((d) => d >= g).length / days.length) * 100).toFixed(0) : "0");
    console.log(
      `  ${fam.def.name.padEnd(10)} ${sized.length} trades · ${days.length} days · median ${med(sorted) >= 0 ? "+" : ""}$${med(sorted).toFixed(0)} · ` +
        `worst $${sorted[0].toFixed(0)} · best $${sorted[sorted.length - 1].toFixed(0)} · P(day≥$500)=${pGoal(500)}% · P(day≥$900)=${pGoal(900)}%`,
    );
    console.log(`              eval: ${accountLine(evalSim)}`);
    console.log(`              funded: ${accountLine(funded)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
