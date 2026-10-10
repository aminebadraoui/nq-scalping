/* ------------------------------------------------------------------ *
 * Stop-run study — trade-review finding #3 (2026-10-02): do stopped-out
 * momentum trades cluster by hour / trigger type, and does padding the
 * stop pay?
 *
 * The pattern: 3 of 5 losses that night stopped within a tick of the
 * exact swing extreme, then the market ran hard in the trade direction
 * (19:15, 00:41, 01:27). For every stopped trade this replay measures:
 *
 *   stopDepth   = pts the market probed BEYOND the stop (adverse)
 *   postStopFav = pts it then ran back in the trade direction from stop
 *
 * A "stop-run" = stopped within 0.75 pt of the extreme AND the market
 * then moved ≥ 1× risk in the trade direction within 30 bars.
 *
 * Phase 1 clusters stop-runs by hour (ET) × trigger × direction.
 * Phase 2 sweeps stopPad {0.5, 0.75, 1.0, 1.5} plus an hour-conditional
 * pad (stopPadNight: 00:00–02:00 ET only) and prints the account sim.
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/stopRunStudy.ts [--max N] [--split 2026-01-01] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
  type MomConfig,
  type ExpansionConfig,
} from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { scoreTrade as engineScoreTrade, coreStats, renderT1, renderT2, renderT4, renderVerdict, propViability } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const POST_BARS = 30; // post-stop probe/reversal measured over this many bars
const RUN_DEPTH_PTS = 0.75; // "within a tick of the extreme" (ticks are 0.25)

type Scored = {
  date: string;
  hourET: number;
  kind: "flush" | "expansion";
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
  stopDepth: number; // pts probed beyond the stop (stopped trades only)
  postStopFav: number; // pts run back in the trade direction after the stop
};

function scoreTrade(minutes: MomMinute[], sig: MomentumSignal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const sc = engineScoreTrade(minutes, { dir, entry: sig.entry, stop: sig.stop, target: sig.target, entryIdx: sig.entryIdx, risk: sig.risk });
  if (!sc) return null;

  // post-stop probe (the engine scores exit/pnl; the run measurement
  // stays here, derived from the engine's stop bar = entryIdx + heldBars)
  let stopDepth = 0;
  let postStopFav = 0;
  if (sc.hit === "stop") {
    const j = sig.entryIdx + sc.heldBars;
    const to = Math.min(minutes.length - 1, j + POST_BARS);
    let worst = dir > 0 ? minutes[j].low : minutes[j].high;
    let best = dir > 0 ? minutes[j].high : minutes[j].low;
    for (let q = j; q <= to; q++) {
      if (dir > 0) {
        worst = Math.min(worst, minutes[q].low);
        best = Math.max(best, minutes[q].high);
      } else {
        worst = Math.max(worst, minutes[q].high);
        best = Math.min(best, minutes[q].low);
      }
    }
    stopDepth = Math.max(0, dir > 0 ? sig.stop - worst : worst - sig.stop);
    postStopFav = Math.max(0, dir > 0 ? best - sig.stop : sig.stop - best);
  }

  return {
    date,
    hourET: sig.hourET,
    kind: sig.kind,
    dir: sig.dir,
    entry: sig.entry,
    stop: sig.stop,
    risk: sig.risk,
    pnl: sc.pnl,
    hit: sc.hit,
    heldBars: sc.heldBars,
    stopDepth,
    postStopFav,
  };
}

/** one trade at a time (the live trader cannot be in two positions) */
function replay(minutes: MomMinute[], sigs: MomentumSignal[], date: string): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const sc = scoreTrade(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.entryIdx + sc.heldBars;
  }
  return out;
}

/* ---------------- aggregation ---------------- */

function isStopRun(t: Scored, favR = 1): boolean {
  return t.hit === "stop" && t.stopDepth <= RUN_DEPTH_PTS && t.postStopFav >= favR * t.risk;
}

function bucketStats(tt: Scored[]) {
  // WR/PF/net come from the consolidated engine (identical formulas:
  // wins = pnl>0, pf = grossWin/grossLoss, net = grossWin − grossLoss)
  const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  const stops = tt.filter((t) => t.hit === "stop");
  const runs = stops.filter((t) => isStopRun(t));
  const meanDepth = stops.length ? stops.reduce((a, t) => a + t.stopDepth, 0) / stops.length : 0;
  const meanFavR = stops.length ? stops.reduce((a, t) => a + t.postStopFav / t.risk, 0) / stops.length : 0;
  return {
    n: s.n,
    wins: s.wins,
    wr: s.wr,
    pf: s.pf,
    net: s.netPts,
    stops: stops.length,
    runs: runs.length,
    runShare: stops.length ? (runs.length / stops.length) * 100 : 0,
    meanDepth,
    meanFavR,
  };
}

function fmtBucket(s: ReturnType<typeof bucketStats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return [
    `n=${String(s.n).padStart(5)}`,
    `wr=${s.wr.toFixed(1).padStart(5)}%`,
    `pf=${pf.padStart(5)}`,
    `net=${s.net.toFixed(0).padStart(7)}`,
    `stops=${String(s.stops).padStart(4)}`,
    `runs=${String(s.runs).padStart(4)}`,
    `run%=${s.runShare.toFixed(0).padStart(3)}%`,
    `depth=${s.meanDepth.toFixed(2)}`,
    `favR=${s.meanFavR.toFixed(2)}`,
  ].join(" ");
}

/* ---------------- main ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; offline: boolean } = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const splitDate = o.split ?? "2026-01-01";

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions (sequential, first-touch, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit)`);

  const pads: { label: string; mom: MomConfig; exp: ExpansionConfig }[] = [
    { label: "pad 0.5 (prod)", mom: { ...MOM_PROD }, exp: { ...EXP_PROD } },
    { label: "pad 0.75", mom: { ...MOM_PROD, stopPad: 0.75 }, exp: { ...EXP_PROD, stopPad: 0.75 } },
    { label: "pad 1.0", mom: { ...MOM_PROD, stopPad: 1.0 }, exp: { ...EXP_PROD, stopPad: 1.0 } },
    { label: "pad 1.5", mom: { ...MOM_PROD, stopPad: 1.5 }, exp: { ...EXP_PROD, stopPad: 1.5 } },
    { label: "night 1.0 (00-02 ET)", mom: { ...MOM_PROD, stopPadNight: 1.0 }, exp: { ...EXP_PROD, stopPadNight: 1.0 } },
    { label: "night 1.5 (00-02 ET)", mom: { ...MOM_PROD, stopPadNight: 1.5 }, exp: { ...EXP_PROD, stopPadNight: 1.5 } },
  ];
  const results = pads.map((p) => ({ label: p.label, mom: [] as Scored[], exp: [] as Scored[] }));

  const t0 = Date.now();
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      for (let p = 0; p < pads.length; p++) {
        results[p].mom.push(...replay(minutes, detectMomentum(minutes, pads[p].mom), date));
        results[p].exp.push(...replay(minutes, detectExpansionScalp(minutes, pads[p].exp), date));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  const prod = results[0]; // phase 1 = production configs
  const all = [...prod.mom, ...prod.exp];

  /* ---- phase 1: clustering (production pads) ---- */
  console.log("PHASE 1 — where do stop-runs live? (prod config, run = depth≤0.75 && fav≥1R)");
  console.log(`  mom flush trigger: ${fmtBucket(bucketStats(prod.mom))}`);
  console.log(`  exp trigger:       ${fmtBucket(bucketStats(prod.exp))}\n`);

  const byHour = new Map<number, Scored[]>();
  for (const t of all) {
    const a = byHour.get(t.hourET);
    if (a) a.push(t);
    else byHour.set(t.hourET, [t]);
  }
  console.log("  by hour (ET) — stops / stop-runs / avg depth / avg fav run:");
  for (const [h, tt] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const s = bucketStats(tt);
    console.log(
      `    ${String(h).padStart(2)}:00  n=${String(s.n).padStart(4)}  wr=${s.wr.toFixed(1).padStart(5)}%  ` +
        `stops=${String(s.stops).padStart(3)}  run%=${s.runShare.toFixed(0).padStart(3)}%  ` +
        `depth=${s.meanDepth.toFixed(2)}  favR=${s.meanFavR.toFixed(2)}`,
    );
  }
  console.log();

  const byKindDir = new Map<string, Scored[]>();
  for (const t of all) {
    const k = `${t.kind} ${t.dir}`;
    const a = byKindDir.get(k);
    if (a) a.push(t);
    else byKindDir.set(k, [t]);
  }
  console.log("  by trigger × direction:");
  for (const [k, tt] of [...byKindDir.entries()].sort()) {
    console.log(`    ${k.padEnd(16)} ${fmtBucket(bucketStats(tt))}`);
  }
  console.log();

  console.log("  stop-run sensitivity (share of stops that qualify):");
  for (const fam of [
    { name: "flush", tr: prod.mom },
    { name: "expansion", tr: prod.exp },
  ]) {
    const stops = fam.tr.filter((t) => t.hit === "stop");
    const row: string[] = [];
    for (const favR of [0.5, 1, 1.5, 2]) {
      const n = stops.filter((t) => t.stopDepth <= RUN_DEPTH_PTS && t.postStopFav >= favR * t.risk).length;
      row.push(`≥${favR}R fav+shallow: ${stops.length ? ((n / stops.length) * 100).toFixed(0) : 0}%`);
    }
    console.log(`    ${fam.name.padEnd(10)} stops=${stops.length} | ${row.join(" | ")}`);
  }
  console.log();

  /* ---- phase 2: pad sweep ---- */
  console.log(`PHASE 2 — pad sweep (split ${splitDate}):`);
  for (const r of results) {
    for (const fam of [
      { name: "mom", tr: r.mom },
      { name: "exp", tr: r.exp },
    ]) {
      const b = bucketStats(fam.tr);
      const d = dollarize(fam.tr.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
      const evAll = simulateAccount(d, "eval");
      const evTest = simulateAccount(d.filter((t) => t.date >= splitDate), "eval");
      const worstAll = evAll.days.reduce((a, x) => Math.min(a, x.pnl), 0);
      const worstTest = evTest.days.reduce((a, x) => Math.min(a, x.pnl), 0);
      const dollarNet = d.reduce((a, t) => a + t.pnl, 0);
      console.log(
        `${r.label.padEnd(22)} ${fam.name.padEnd(3)} | ${fmtBucket(b)} | net $${dollarNet.toFixed(0).padStart(7)} | ` +
          `worstDay $${worstAll.toFixed(0).padStart(5)} (test $${worstTest.toFixed(0).padStart(5)}) | ` +
          `eval[all] ${accountLine(evAll)} | eval[test] ${accountLine(evTest)}`,
      );
    }
    console.log();
  }

  /* ==== STANDARD REPORT (consolidated engine) ==== */
  const engineTrades = [...prod.mom, ...prod.exp].map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  const etAll = coreStats(engineTrades);
  const etTrain = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const etTest = coreStats(engineTrades.filter((t) => t.date >= splitDate));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([
    { label: "all (prod pads, mom+exp)", stats: etAll },
    { label: "train", stats: etTrain },
    { label: "test", stats: etTest },
  ]));

  const t2rows = results.flatMap((r) =>
    (["mom", "exp"] as const).map((fam) => {
      const tr = r[fam];
      const s = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      const train = coreStats(tr.filter((t) => t.date < splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      const test = coreStats(tr.filter((t) => t.date >= splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      const other = fam === "mom" ? r.exp : r.mom;
      const so = coreStats(other.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      return {
        rule: `${r.label} · ${fam}`,
        n: s.n,
        wr: s.wr,
        ci: s.wrCi,
        pf: s.pf,
        expPts: s.expPts,
        trainTest: `${train.wr.toFixed(0)}% / ${test.wr.toFixed(0)}%`,
        compare: `${fam === "mom" ? "exp" : "mom"}: wr ${so.wr.toFixed(1)}% pf ${Number.isFinite(so.pf) ? so.pf.toFixed(2) : "inf"}`,
      };
    }),
  );
  console.log("\n" + renderT2(t2rows));

  const v = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(v));
  console.log(renderVerdict({
    edge: etTest.netPts > 0 && etTest.expR > 0 ? "real" : "absent",
    significance: "—",
    stability: `train/test WR gap ${Math.abs(etTrain.wr - etTest.wr).toFixed(1)} pts`,
    holdout: "n/a (validation pipeline)",
    viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
