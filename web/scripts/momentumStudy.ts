/* ------------------------------------------------------------------ *
 * Momentum study — replay the momentum detector over the R2 archive.
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/momentumStudy.ts [--max N] [--split 2026-01-01] \
 *     [--cfg flushFrac=0.3,breakFrac=0.6] [--sweep] [--dump out.json]
 *
 * Sessions are disk-cached (parsed candles) so threshold sweeps re-run
 * in seconds. Signals are scored forward with the pessimistic same-bar
 * rule (stop first when both stop and target sit in one bar), 0.5 pt
 * round-trip cost, 60-bar time exit.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectOpenDrive, OPEN_DEFAULTS, type OpenDriveConfig } from "../lib/openDrive";
import {
  detectMomentum,
  detectExpansionScalp,
  closeOf,
  MOM_DEFAULTS,
  EXP_DEFAULTS,
  type MomConfig,
  type ExpansionConfig,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";

const REMOTE = process.env.GC_REMOTE_URL?.replace(/\/+$/, "") ?? "";
const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; cfg: Partial<MomConfig>; dump?: string; sweep: boolean; mode: "momentum" | "expansion" | "open"; sequential: boolean } = {
    cfg: {},
    sweep: false,
    mode: "momentum",
    sequential: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--mode") o.mode = argv[++i] as "momentum" | "expansion" | "open";
    else if (a === "--sequential") o.sequential = true;
    else if (a === "--cfg") {
      for (const kv of argv[++i].split(",")) {
        const [k, v] = kv.split("=");
        if (!k || v === undefined) continue;
        (o.cfg as Record<string, unknown>)[k.trim()] = Number(v);
      }
    } else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--sweep") o.sweep = true;
  }
  return o;
}

/* ---------------- trade scoring ---------------- */

type ScoredSignal = MomentumSignal & {
  date: string;
  exit: number;
  pnl: number; // net points after cost
  hit: "target" | "stop" | "time";
  heldBars: number;
  mfeR: number;
  maeR: number;
  runPts: number;
  hit2R: boolean;
  hit3R: boolean;
  ambiguous: boolean;
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string): ScoredSignal | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;

  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;

  let hit: ScoredSignal["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.entryIdx;
  let mfe = 0;
  let mae = 0;
  let run = 0;
  let ambiguous = false;
  let hit2R = false;
  let hit3R = false;
  const t2 = dir > 0 ? entry + 2 * risk : entry - 2 * risk;
  const t3 = dir > 0 ? entry + 3 * risk : entry - 3 * risk;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    run = Math.max(run, fav);
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (j === start && stopHit && tgtHit) ambiguous = true;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - sig.entryIdx;
      break;
    }
    if (dir > 0 ? b.high >= t3 : b.low <= t3) hit3R = true;
    if (dir > 0 ? b.high >= t2 : b.low <= t2) hit2R = true;
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - sig.entryIdx;
      break;
    }
  }

  const pnl = (exit - entry) * dir - COST_PTS;
  return { ...sig, date, exit, pnl, hit, heldBars, mfeR: mfe, maeR: mae, runPts: run, hit2R, hit3R, ambiguous };
}

/** one trade at a time: a signal whose entry bar falls inside an open trade
 *  (entryIdx ≤ open trade's exit bar) is skipped — the live trader cannot be
 *  in two trades. Signals are processed in order. */
function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string): ScoredSignal[] {
  const out: ScoredSignal[] = [];
  let openUntil = -1;
  for (const s of signals) {
    if (s.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = sc.entryIdx + sc.heldBars;
  }
  return out;
}

/* ---------------- aggregation ---------------- */

type Stats = {
  n: number;
  wins: number;
  wr: number;
  pf: number;
  avgPts: number;
  avgRisk: number;
  expR: number;
  ambiguousShare: number;
  hit2RShare: number;
  hit3RShare: number;
  mfeMean: number;
  maeMean: number;
  runPtsMean: number;
  netPts: number;
  sessionsWithSignals: number;
};

function stats(trades: ScoredSignal[]): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const sessions = new Set(trades.map((t) => t.date)).size;
  return {
    n,
    wins: wins.length,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgPts: n ? net / n : 0,
    avgRisk: n ? trades.reduce((a, t) => a + t.risk, 0) / n : 0,
    expR: n ? trades.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0,
    ambiguousShare: n ? (trades.filter((t) => t.ambiguous).length / n) * 100 : 0,
    hit2RShare: n ? (trades.filter((t) => t.hit2R).length / n) * 100 : 0,
    hit3RShare: n ? (trades.filter((t) => t.hit3R).length / n) * 100 : 0,
    mfeMean: n ? trades.reduce((a, t) => a + t.mfeR, 0) / n : 0,
    maeMean: n ? trades.reduce((a, t) => a + t.maeR, 0) / n : 0,
    runPtsMean: n ? trades.reduce((a, t) => a + t.runPts, 0) / n : 0,
    netPts: net,
    sessionsWithSignals: sessions,
  };
}

function fmt(s: Stats): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return [
    `n=${String(s.n).padStart(5)}`,
    `wr=${s.wr.toFixed(1).padStart(5)}%`,
    `pf=${pf.padStart(5)}`,
    `avgPts=${s.avgPts.toFixed(2).padStart(7)}`,
    `expR=${s.expR.toFixed(2).padStart(5)}`,
    `mfeR=${s.mfeMean.toFixed(2)}`,
    `maeR=${s.maeMean.toFixed(2)}`,
    `2R=${s.hit2RShare.toFixed(0).padStart(3)}%`,
    `3R=${s.hit3RShare.toFixed(0).padStart(3)}%`,
    `amb=${s.ambiguousShare.toFixed(0).padStart(2)}%`,
    `net=${s.netPts.toFixed(0).padStart(7)}pts`,
    `sess=${s.sessionsWithSignals}`,
  ].join(" ");
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/* ---------------- sweep variants ---------------- */

const SWEEP_VARIANTS: { name: string; overrides: Partial<MomConfig> }[] = [
  // candle-size × footprint research: breakout-bar quality filters
  { name: "prod", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false } },
  { name: "prod+rr0.8", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.8 } },
  { name: "prod+rr0.85", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85 } },
  { name: "prod+rr0.9", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.9 } },
  { name: "prod+rr1.0", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 1.0 } },
  { name: "prod+rr1.2", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 1.2 } },
  { name: "prod+stack", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, requireBreakStack: true } },
  { name: "prod+rr0.8+stack", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.8, requireBreakStack: true } },
  { name: "prod+rr1.0+stack", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 1.0, requireBreakStack: true } },
  { name: "prod+rr1.0+stack+b85", overrides: { stopMode: "breakout", breakFrac: 0.85, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 1.0, requireBreakStack: true } },
  { name: "prod+quietBefore", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, quietBeforeFlush: true } },
  { name: "prod+churnVeto", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, churnVeto: true } },
  { name: "prod+quiet+churn", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, quietBeforeFlush: true, churnVeto: true } },
  { name: "prod+poc", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, requireBreakPoc: true } },
  { name: "prod+pocMove", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, requirePocMove: true } },
  { name: "prod+poc+pocMove", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, requireBreakPoc: true, requirePocMove: true } },
  { name: "prod+local20", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 20 } },
  { name: "prod+local1", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 1 } },
  { name: "prod+local2", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 2 } },
  { name: "prod+local3", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 3 } },
  { name: "prod+local5", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 5 } },
  { name: "prod+open", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, hourFilter: "globexOpen" } },
  { name: "prod+local60", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 60 } },
  { name: "prod+local120", overrides: { stopMode: "breakout", breakFrac: 0.75, minRiskPts: 3, breakWindow: 10, needResponse: false, minBreakRangeR: 0.85, failAnchor: "local", failLocalBars: 120 } },
];

const EXPANSION_VARIANTS: { name: string; overrides: Partial<ExpansionConfig> }[] = [
  { name: "exp1.4s", overrides: { minRangeR: 1.4, minAbsDeltaFrac: 0.5, requireStack: true } },
  { name: "exp1.4ns", overrides: { minRangeR: 1.4, minAbsDeltaFrac: 0.5, requireStack: false } },
  { name: "exp1.6s", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: true } },
  { name: "exp1.6ns", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: false } },
  { name: "exp1.8s", overrides: { minRangeR: 1.8, minAbsDeltaFrac: 0.5, requireStack: true } },
  { name: "exp2.0s", overrides: { minRangeR: 2.0, minAbsDeltaFrac: 0.5, requireStack: true } },
  { name: "exp1.6s+df0.4", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.4, requireStack: true } },
  { name: "exp1.6s+df0.6", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.6, requireStack: true } },
  { name: "exp1.4s+df0.4", overrides: { minRangeR: 1.4, minAbsDeltaFrac: 0.4, requireStack: true } },
  { name: "exp1.6s+poc", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: true, requireBreakPoc: true } },
  { name: "exp1.6s+pocMove", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: true, requirePocMove: true } },
  { name: "exp1.6s+poc+pocMove", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: true, requireBreakPoc: true, requirePocMove: true } },
  { name: "exp1.6s+open", overrides: { minRangeR: 1.6, minAbsDeltaFrac: 0.5, requireStack: true, hourFilter: "globexOpen" } },
];

const OPEN_VARIANTS: { name: string; overrides: Partial<OpenDriveConfig> }[] = [
  { name: "soft300", overrides: { cumDeltaFloor: 300, minBuyFrac: 0.5, volMedMult: 1.5, minRangeR: 1.5, entryMode: "high", windowMin: 45 } },
  { name: "soft200", overrides: { cumDeltaFloor: 200, minBuyFrac: 0.5, volMedMult: 1.5, minRangeR: 1.5, entryMode: "high", windowMin: 45 } },
  { name: "soft300c", overrides: { cumDeltaFloor: 300, minBuyFrac: 0.5, volMedMult: 1.5, minRangeR: 1.5, entryMode: "close", windowMin: 45 } },
  { name: "o300f50", overrides: { cumDeltaFloor: 300, minBuyFrac: 0.5 } },
];

/* ---------------- main ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  const splitDate = o.split ?? "2026-01-01";
  const mode = o.mode;
  const variants: { name: string; cfg: MomConfig | ExpansionConfig | OpenDriveConfig }[] =
    mode === "open"
      ? OPEN_VARIANTS.map((v) => ({ name: v.name, cfg: { ...OPEN_DEFAULTS, ...v.overrides } }))
      : mode === "expansion"
        ? EXPANSION_VARIANTS.map((v) => ({ name: v.name, cfg: { ...EXP_DEFAULTS, ...v.overrides } }))
        : o.sweep
          ? SWEEP_VARIANTS.map((v) => ({ name: v.name, cfg: { ...MOM_DEFAULTS, ...o.cfg, ...v.overrides } }))
          : [{ name: "custom", cfg: { ...MOM_DEFAULTS, ...o.cfg } }];

  console.log(`mode: ${mode} | split: ${splitDate} | variants: ${variants.map((v) => v.name).join(", ")}`);
  let dates = await archiveDates();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions…`);
  const t0 = Date.now();

  const perVariant = variants.map(() => [] as ScoredSignal[]);
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(
      chunk.map(async (date) => {
        const minutes = await loadSessionMinutes(date);
        return { date, minutes };
      }),
    );
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      for (let v = 0; v < variants.length; v++) {
        const signals =
          mode === "open"
            ? detectOpenDrive(minutes, variants[v].cfg as OpenDriveConfig)
            : mode === "expansion"
              ? detectExpansionScalp(minutes, variants[v].cfg as ExpansionConfig)
              : detectMomentum(minutes, variants[v].cfg as MomConfig);
        if (o.sequential) {
          perVariant[v].push(...scoreSequential(minutes, signals, date));
        } else {
          for (const s of signals) {
            const sc = scoreSignal(minutes, s, date);
            if (sc) perVariant[v].push(sc);
          }
        }
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }

  console.log(`\n${(Date.now() - t0) / 1000}s · ${loaded} sessions loaded · ${failed} failed\n`);

  const rows: { name: string; all: Stats; train: Stats; test: Stats }[] = [];
  for (let v = 0; v < variants.length; v++) {
    const tr = perVariant[v];
    rows.push({
      name: variants[v].name,
      all: stats(tr),
      train: stats(tr.filter((t) => t.date < splitDate)),
      test: stats(tr.filter((t) => t.date >= splitDate)),
    });
  }
  // sort by train win rate desc, then test net
  rows.sort((a, b) => b.train.wr - a.train.wr || b.test.netPts - a.test.netPts);
  console.log("variant            | ALL");
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(17)} | ${fmt(r.all)}`,
    );
    console.log(`${"".padEnd(17)} |  TRAIN ${fmt(r.train)}`);
    console.log(`${"".padEnd(17)} |  TEST  ${fmt(r.test)}`);
  }

  /* ---- the rules layer: every run is sized and simmed against the
   *      Rapid EOD 50k plan (30-micro cap, $2/pt, EOD MLL $2,000) ---- */
  console.log("\nACCOUNT (Rapid EOD 50k · $170/trade budget · 30-micro cap):");
  const dumpAccount: Record<string, unknown> = {};
  for (let v = 0; v < variants.length; v++) {
    const trades = perVariant[v];
    const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const evalAll = simulateAccount(d, "eval");
    const fundedAll = simulateAccount(d, "funded");
    const evalTest = simulateAccount(d.filter((t) => t.date >= splitDate), "eval");
    const fundedTest = simulateAccount(d.filter((t) => t.date >= splitDate), "funded");
    const dollarNet = d.reduce((a, t) => a + t.pnl, 0);
    console.log(
      `${variants[v].name.padEnd(17)} | net $${dollarNet.toFixed(0).padStart(6)} · eval[all] ${accountLine(evalAll)} · funded[test] ${accountLine(fundedTest)}`,
    );
    dumpAccount[variants[v].name] = { dollarNet, evalAll, fundedAll, evalTest, fundedTest };
  }

  // winners vs losers features for the best variant (by test wr)
  const best = rows[0];
  const bv = variants.findIndex((v) => v.name === best.name);
  const tr = perVariant[bv];
  const wins = tr.filter((t) => t.pnl > 0);
  const losses = tr.filter((t) => t.pnl <= 0);
  const feats: (keyof ScoredSignal)[] = [
    "flushFrac", "flushVol", "flushRange", "failDepth", "trailLowDist", "trailHighDist",
    "respFrac", "respVol", "respDelay", "respProof", "breakFrac", "breakVol",
    "breakDelay", "refDist", "progressPts", "medVol", "distVwapPts", "deltaFromFlush", "atr14", "riskPts",
  ];
  console.log(`\nfeature table for "${best.name}" | winners n=${wins.length} | losers n=${losses.length}`);
  for (const f of feats) {
    const wv = mean(wins.map((t) => t[f] as number));
    const lv = mean(losses.map((t) => t[f] as number));
    console.log(`  ${f.padEnd(16)} | ${wv.toFixed(2).padStart(10)} | ${lv.toFixed(2).padStart(10)}`);
  }

  // by hour for the best variant
  const byHour = new Map<number, ScoredSignal[]>();
  for (const t of tr) {
    const a = byHour.get(t.hourET);
    if (a) a.push(t);
    else byHour.set(t.hourET, [t]);
  }
  console.log(`\n"${best.name}" by hour (ET):`);
  for (const [h, tt] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(h).padStart(2)}:00: ${fmt(stats(tt))}`);
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify({ generated: new Date().toISOString(), variants: variants.map((v) => v.cfg), trades: Object.fromEntries(variants.map((v, idx) => [v.name, perVariant[idx]])), account: dumpAccount }, null, 1),
    );
    console.log(`\nsignals dumped → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
