/* ------------------------------------------------------------------ *
 * Runner study — every production strategy re-scored with the ladder
 * exit (../lib/runner.ts): open target, stop → BE at +1R, → +1R at
 * +2R, → +2R at +3R, …, 60-minute time exit.
 *
 * Grounded in MyFundedFutures Rapid EOD 50k: per-family trades are
 * dollarized at the live sizing (9 MNQ fixed for momentum/expansion/
 * RTH, $170-budget sizing for the open drive) and replayed through
 * simulateAccount (EOD-trailing $2,000 MLL, $100 lock, 30% consistency,
 * $2,100 buffer / $500 payouts) — eval and funded — plus the day-P&L
 * distribution (median, worst, P(day ≥ $500), P(day ≥ $900)).
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/runnerStudy.ts [--family momentum|expansion|rth|open|all] \
 *     [--max N] [--offline] [--maxBars 60]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { scoreRunner, scoreScaleOut, type RunnerTrade, type ScaleOutTrade } from "../lib/runner";
import { closeOf } from "../lib/momentum";
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
  targetR: number; // fixed-target R (open drive: 15 pts on a 35-pt stop)
  closeAtRthClose: boolean; // RTH strategies must never hold past 16:00 ET
};

const FAMILIES: FamilyDef[] = [
  { name: "momentum", closeAtRthClose: false, detect: (m) => [...detectMomentum(m, MOM_PROD), ...detectExpansionScalp(m, EXP_PROD)], fixedSize: true, targetR: 1 },
  { name: "expansion", closeAtRthClose: false, detect: (m) => detectExpansionScalp(m, EXP_PROD), fixedSize: true, targetR: 1 },
  { name: "rth", closeAtRthClose: true, detect: (m) => detectSoftMomentum(m, SOFT_PROD), fixedSize: true, targetR: 0.75 },
  { name: "open", closeAtRthClose: false, detect: (m) => detectOpenDrive(m, OPEN_PROD), fixedSize: false, targetR: 15 / 35 },
];

function parseArgs(argv: string[]) {
  const o: {
    family: string; max?: number; offline: boolean; maxBars: number;
    exit: "ladder" | "scaleout" | "fixed"; maxTradesPerDay?: number; dailyGoal?: number; dailyStop?: number;
    targetR?: number; contracts?: number; cost?: number;
  } = {
    family: "all",
    offline: false,
    maxBars: 60,
    exit: "ladder",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--family") o.family = argv[++i];
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--offline") o.offline = true;
    else if (a === "--maxBars") o.maxBars = Number(argv[++i]);
    else if (a === "--exit") o.exit = argv[++i] as "ladder" | "scaleout" | "fixed";
    else if (a === "--targetR") o.targetR = Number(argv[++i]);
    else if (a === "--contracts") o.contracts = Number(argv[++i]);
    else if (a === "--cost") o.cost = Number(argv[++i]);
    else if (a === "--maxTradesPerDay") o.maxTradesPerDay = Number(argv[++i]);
    else if (a === "--dailyGoal") o.dailyGoal = Number(argv[++i]);
    else if (a === "--dailyStop") o.dailyStop = Number(argv[++i]);
  }
  return o;
}

type FixedTrade = {
  pnl: number; risk: number; hit: "stop" | "target" | "time";
  heldBars: number; mfeR: number; maeR: number; ambiguous: boolean;
  exitR: number;
};

function scoreFixed(
  minutes: { high: number; low: number }[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  targetR: number,
  maxBars: number,
  cost = 0.5,
): FixedTrade | null {
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0)) return null;
  const target = entry + dir * targetR * risk;
  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + maxBars);
  if (start > end) return null;
  let exit = stop0;
  let hit: FixedTrade["hit"] = "stop";
  let heldBars = 0;
  let mfe = 0;
  let mae = 0;
  let ambiguous = false;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    const stopHit = dir > 0 ? b.low <= stop0 : b.high >= stop0;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (j === start && stopHit && tgtHit) ambiguous = true;
    if (stopHit) {
      exit = stop0;
      hit = "stop";
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
    // never stopped — time exit at the final close
    const stopHitLast = dir > 0 ? minutes[end].low <= stop0 : minutes[end].high >= stop0;
    if (!stopHitLast) {
      hit = "time";
      exit = (minutes[end].high + minutes[end].low) / 2;
    }
  }
  const exitR = ((exit - entry) * dir) / risk;
  return {
    pnl: (exit - entry) * dir - cost,
    risk,
    hit,
    heldBars,
    mfeR: mfe,
    maeR: mae,
    ambiguous,
    exitR: exitR === 0 ? 0 : exitR,
  };
}

type Outcome = RunnerTrade | ScaleOutTrade | FixedTrade;

function sequentialize(
  minutes: MomMinute[],
  signals: MomentumSignal[],
  maxBars: number | ((entryIdx: number) => number),
  exit: "ladder" | "scaleout" | "fixed",
  targetR: number,
  cost: number,
): Outcome[] {
  const out: Outcome[] = [];
  let openUntil = -1;
  // detectors return separate lists — merge in strict time order so the
  // one-trade-at-a-time rule matches what a live trader actually faces
  const ordered = [...signals].sort((a, b) => a.entryIdx - b.entryIdx);
  for (const s of ordered) {
    if (s.entryIdx <= openUntil) continue; // the live trader cannot be in two trades
    const mb = typeof maxBars === "function" ? maxBars(s.entryIdx) : maxBars;
    if (mb < 1) continue; // e.g. entry at the RTH close itself — no window left
    const dir = s.dir === "long" ? 1 : -1;
    const t =
      exit === "fixed"
        ? scoreFixed(minutes, s.entry, s.stop, dir, s.entryIdx, targetR, mb, cost)
        : exit === "scaleout"
          ? scoreScaleOut(minutes, s.entry, s.stop, dir, s.entryIdx, { maxBars: mb, cost })
          : scoreRunner(minutes, s.entry, s.stop, dir, s.entryIdx, { maxBars: mb, cost });
    if (!t) continue;
    out.push(t);
    openUntil = s.entryIdx + t.heldBars;
  }
  return out;
}

type FamStats = {
  name: string;
  n: number;
  wr: number;
  pf: number;
  avgPts: number;
  expR: number;
  timePct: number;
  ambPct: number;
  mfeR: number;
  maeR: number;
  avgHeld: number;
  netPts: number;
  sessions: number;
  // ladder columns
  avgExitR: number;
  fullLossPct: number;
  bePct: number;
  ge1RPct: number;
  ge2RPct: number;
  ge3RPct: number;
  // scale-out columns
  avgTotalR: number;
  bankedPct: number;
  bankBePct: number;
  totGe3RPct: number;
  totGe4RPct: number;
  totGe5RPct: number;
};

function famStats(name: string, trades: { t: Outcome; date: string }[], exit: "ladder" | "scaleout" | "fixed"): FamStats {
  const rs = trades.map((x) => x.t);
  const n = rs.length;
  const wins = rs.filter((t) => t.pnl > 0);
  const losses = rs.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = rs.reduce((a, t) => a + t.pnl, 0);
  const pct = (f: (t: Outcome) => boolean) => (n ? (rs.filter(f).length / n) * 100 : 0);
  const isLadder = exit !== "scaleout"; // fixed targets share the ladder's per-unit exitR semantics
  const ladder = (t: Outcome) => t as RunnerTrade;
  const scale = (t: Outcome) => t as ScaleOutTrade;
  return {
    name,
    n,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgPts: n ? net / n : 0,
    expR: n ? rs.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0,
    timePct: pct((t) => t.hit === "time"),
    ambPct: pct((t) => t.ambiguous),
    mfeR: n ? rs.reduce((a, t) => a + t.mfeR, 0) / n : 0,
    maeR: n ? rs.reduce((a, t) => a + t.maeR, 0) / n : 0,
    avgHeld: n ? rs.reduce((a, t) => a + t.heldBars, 0) / n : 0,
    netPts: net,
    sessions: new Set(trades.map((x) => x.date)).size,
    avgExitR: isLadder ? (n ? rs.reduce((a, t) => a + ladder(t).exitR, 0) / n : 0) : 0,
    fullLossPct: pct((t) => (isLadder ? ladder(t).exitR <= -0.999 : scale(t).fullLoss)),
    bePct: pct((t) => (isLadder ? ladder(t).exitR === 0 : scale(t).banked && scale(t).runnerExitR === 0)),
    ge1RPct: pct((t) => (isLadder ? ladder(t).exitR >= 1 : scale(t).totalR >= 2)),
    ge2RPct: pct((t) => (isLadder ? ladder(t).exitR >= 2 : scale(t).totalR >= 3)),
    ge3RPct: pct((t) => (isLadder ? ladder(t).exitR >= 3 : scale(t).totalR >= 4)),
    avgTotalR: isLadder ? 0 : (n ? rs.reduce((a, t) => a + scale(t).totalR, 0) / n : 0),
    bankedPct: pct((t) => scale(t).banked),
    bankBePct: pct((t) => scale(t).banked && scale(t).runnerExitR === 0),
    totGe3RPct: pct((t) => scale(t).totalR >= 3),
    totGe4RPct: pct((t) => scale(t).totalR >= 4),
    totGe5RPct: pct((t) => scale(t).totalR >= 5),
  };
}

function fmtFam(s: FamStats, exit: "ladder" | "scaleout" | "fixed"): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  const core =
    `${s.name.padEnd(10)} n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} ` +
    `avgPts=${s.avgPts.toFixed(2).padStart(6)} expR=${s.expR.toFixed(2).padStart(5)} `;
  const exitCols =
    exit === "scaleout"
      ? `avgTotR=${s.avgTotalR.toFixed(2).padStart(5)} loss=${s.fullLossPct.toFixed(0).padStart(3)}% ` +
        `bank+BE=${s.bankBePct.toFixed(0).padStart(3)}% tot≥3R=${s.totGe3RPct.toFixed(0).padStart(3)}% tot≥4R=${s.totGe4RPct.toFixed(0).padStart(3)}% tot≥5R=${s.totGe5RPct.toFixed(0).padStart(3)}% `
      : `avgExitR=${s.avgExitR.toFixed(2).padStart(5)} loss=${s.fullLossPct.toFixed(0).padStart(3)}% be=${s.bePct.toFixed(0).padStart(3)}% ` +
        `ge1R=${s.ge1RPct.toFixed(0).padStart(3)}% ge2R=${s.ge2RPct.toFixed(0).padStart(3)}% ge3R=${s.ge3RPct.toFixed(0).padStart(3)}% `;
  const tail =
    `time=${s.timePct.toFixed(0).padStart(3)}% amb=${s.ambPct.toFixed(0).padStart(2)}% ` +
    `mfeR=${s.mfeR.toFixed(2)} maeR=${s.maeR.toFixed(2)} held=${s.avgHeld.toFixed(0).padStart(2)}m ` +
    `net=${s.netPts.toFixed(0).padStart(6)}pts sess=${s.sessions}`;
  return core + exitCols + tail;
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
  console.log(`runner ${o.exit} study · ${dates.length} sessions · families: ${families.map((f) => f.name).join(", ")} · maxBars ${o.maxBars}`);
  const t0 = Date.now();

  const perFamily: { def: FamilyDef; trades: { t: Outcome; date: string }[] }[] = families.map((def) => ({
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
      // 16:00 ET close bar (feed clock "15:00") — RTH strategies must not
      // hold past it, so their lookahead window is clamped there
      const rthCloseIdx = minutes.findIndex((m) => m.t === "15:00");
      for (const fam of perFamily) {
        const signals = fam.def.detect(minutes);
        const effMaxBars: number | ((idx: number) => number) =
          fam.def.closeAtRthClose && rthCloseIdx !== -1
            ? (idx) => Math.min(o.maxBars, rthCloseIdx - idx) // never past 16:00 ET
            : o.maxBars;
        const scored = sequentialize(minutes, signals, effMaxBars, o.exit, o.targetR ?? fam.def.targetR, o.cost ?? 0.5);
        for (const t of scored) fam.trades.push({ t, date });
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }

  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);
  console.log(`POINT-LEVEL (${o.exit} exit, 0.5 pt cost, pessimistic same-bar, sequential${o.exit === "scaleout" ? " — bank 2/3 at 1R, run 1/3" : ""})`);
  for (const fam of perFamily) {
    const s = famStats(fam.def.name, fam.trades, o.exit);
    console.log("  " + fmtFam(s, o.exit));
  }

  console.log("\nMFF RAPID EOD 50k (sizing: 9 MNQ fixed · open drive $170-budget)");
  for (const fam of perFamily) {
    const raw = fam.trades.map(({ t, date }) => ({ date, pnlPts: t.pnl, riskPts: t.risk }));
    if (!raw.length) {
      console.log(`  ${fam.def.name.padEnd(10)} no trades`);
      continue;
    }
    const micros = fam.def.fixedSize ? (o.contracts ?? FIXED_MICROS) : null;
    const sizedAll = fam.def.fixedSize && micros
      ? raw.map((x) => ({ ...x, contracts: micros, pnl: Math.round(x.pnlPts * POINT_VALUE * micros * 100) / 100 }))
      : dollarize(raw);
    // daily guardrails (the live plan): max N trades/day, stop trading once
    // the day's goal is banked or the day's loss floor is touched
    const sized: typeof sizedAll = [];
    if (o.maxTradesPerDay || o.dailyGoal || o.dailyStop) {
      let day = "";
      let dayTrades = 0;
      let dayPnl = 0;
      for (const x of sizedAll) {
        if (x.date !== day) {
          day = x.date;
          dayTrades = 0;
          dayPnl = 0;
        }
        if (o.maxTradesPerDay && dayTrades >= o.maxTradesPerDay) continue;
        if (o.dailyGoal && dayPnl >= o.dailyGoal) continue;
        if (o.dailyStop && dayPnl <= -o.dailyStop) continue;
        sized.push(x);
        dayTrades++;
        dayPnl += x.pnl;
      }
      console.log(
        `              guards: maxTrades/day=${o.maxTradesPerDay ?? "∞"} · goal $${o.dailyGoal ?? "∞"} · stop $${o.dailyStop ?? "∞"} → ${sized.length} of ${sizedAll.length} trades kept`,
      );
    } else {
      sized.push(...sizedAll);
    }
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
