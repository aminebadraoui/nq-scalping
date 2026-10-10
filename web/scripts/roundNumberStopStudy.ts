/* ------------------------------------------------------------------ *
 * Round-number stop-run study — the falsification test of Richie
 * Naso's stop-placement claim (Words of Rizdom, 2024-12):
 *
 *   "don't put [your stop] at 50 — they're going to get hit; put it
 *   at 40, give yourself a chance to breathe."
 *
 * The claim, mechanically: stops parked ON a 50-handle get swept by the
 * algorithmic prints to round numbers. Measured over the momentum-card
 * replay (the same harness as stopRunStudy.ts: sequential, first-touch,
 * 0.5 pt cost, 60-bar exit):
 *
 *   Phase 1  baseline + stop-run definition recap
 *   Phase 2  buckets: stop ON a handle (±1 pt) vs off; |stop distance|
 *            bands; target crossing a handle; entry on a handle.
 *            WR / PF / net / stop-run share / mean probe depth.
 *   Phase 3  Naso's remedy: for the ON-handle stops only, re-score the
 *            trade with the stop moved 1 pt further from the number
 *            ("give it room") — a real replay, wider stop fully
 *            charged, not a probe-depth approximation.
 *
 * The chip features this consumes (lib/roundNumbers.ts) are the same
 * ones logged live on every card — one definition, two consumers.
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/roundNumberStopStudy.ts [--max N] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { roundNumberChips, nearestRound, AT_ROUND_PTS, type RoundNumberChips } from "../lib/roundNumbers";
// consolidated engine: canonical scorer + standard T1/T4 + verdict
import { scoreTrade as engineScoreTrade, coreStats, propViability, renderT1, renderT4, renderVerdict } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const POST_BARS = 30;
const RUN_DEPTH_PTS = 0.75; // "within a tick of the extreme" (ticks are 0.25)
const PAD_PTS = 1.0; // Naso's "give it room" remedy in Phase 3

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
  stopDepth: number; // pts probed beyond the stop (stopped trades only)
  postStopFav: number; // pts run back in the trade direction after the stop
  rn: RoundNumberChips["features"];
};

/** score one trade with an optional stop override (Phase 3 re-score) */
function scoreTrade(minutes: MomMinute[], sig: MomentumSignal, date: string, stopOverride?: number): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const entry = sig.entry;
  const stop = stopOverride ?? sig.stop;
  const target = sig.target;
  const risk = Math.abs(entry - stop);
  // the consolidated engine's canonical scorer (pessimistic stop-first,
  // 0.5 pt cost, 60-bar time exit, midpoint close). Momentum signals
  // always satisfy stop < entry < target, and the pad override moves the
  // stop at most 1 pt while prod risk is ≥ 3 pts, so the geometry stays
  // valid on every path.
  const sc = engineScoreTrade(
    minutes,
    { dir, entry, stop, target, entryIdx: sig.entryIdx, risk },
    { costPts: COST_PTS, holdBars: HOLD_BARS },
  );
  if (!sc) return null;

  // stop-run probe (historical behavior, unchanged): on a stop, how deep
  // beyond the stop did price probe and how far did it run back in the
  // trade direction within POST_BARS of the stop bar.
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
    stopDepth = Math.max(0, dir > 0 ? stop - worst : worst - stop);
    postStopFav = Math.max(0, dir > 0 ? best - stop : stop - best);
  }

  const rn = roundNumberChips(sig).features;
  return { date, hourET: sig.hourET, kind: sig.kind, dir: sig.dir, entry, stop, risk, pnl: sc.pnl, hit: sc.hit, stopDepth, postStopFav, rn };
}

/** the same stop widened 1 pt away from its nearest handle */
function stopOffTheNumber(stop: number): number {
  const round = nearestRound(stop);
  return stop >= round ? stop + PAD_PTS : stop - PAD_PTS;
}

/** one trade at a time (the live trader cannot be in two positions).
 *  On-handle stops are ALSO re-scored with the padded stop (Phase 3). */
function replay(
  minutes: MomMinute[],
  sigs: MomentumSignal[],
  date: string,
): { base: Scored[]; padded: Scored[] } {
  const base: Scored[] = [];
  const padded: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const sc = scoreTrade(minutes, s, date);
    if (!sc) continue;
    base.push(sc);
    openUntil = s.entryIdx + HOLD_BARS;
    if (sc.rn.stopAtRound === true) {
      const pw = scoreTrade(minutes, s, date, stopOffTheNumber(s.stop));
      if (pw) padded.push(pw);
    }
  }
  return { base, padded };
}

/* ---------------- aggregation ---------------- */

function isStopRun(t: Scored, favR = 1): boolean {
  return t.hit === "stop" && t.stopDepth <= RUN_DEPTH_PTS && t.postStopFav >= favR * t.risk;
}

function stats(tt: Scored[]) {
  // WR/PF/net from the standard metric set (identical formulas); the
  // stop-run anatomy stays local (it has no engine equivalent).
  const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  const stops = tt.filter((t) => t.hit === "stop");
  const runs = stops.filter((t) => isStopRun(t));
  const meanDepth = stops.length ? stops.reduce((a, t) => a + t.stopDepth, 0) / stops.length : 0;
  return {
    n: s.n,
    wr: s.wr,
    pf: s.pf,
    net: s.netPts,
    stops: stops.length,
    runs: runs.length,
    runShare: stops.length ? (runs.length / stops.length) * 100 : 0,
    meanDepth,
  };
}

function fmtRow(s: ReturnType<typeof stats>): string {
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
  ].join(" ");
}

function bandRow(label: string, tt: Scored[]): string {
  return `${label.padEnd(28)} ${fmtRow(stats(tt))}`;
}

/* ---------------- main ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; offline: boolean } = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(
    `round-number stop-run study · ${dates.length} sessions · sequential, first-touch, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit`,
  );

  const all: Scored[] = [];
  const padded: Scored[] = [];
  const t0 = Date.now();
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      const r = replay(minutes, detectMomentum(minutes, MOM_PROD), date);
      all.push(...r.base);
      padded.push(...r.padded);
      const e = replay(minutes, detectExpansionScalp(minutes, EXP_PROD), date);
      all.push(...e.base);
      padded.push(...e.padded);
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed · ${all.length} trades\n`);

  console.log("PHASE 1 — baseline");
  console.log(`  all:          ${fmtRow(stats(all))}\n`);

  console.log("PHASE 2 — where does the ticket sit relative to the 50-handles?");
  const onRound = all.filter((t) => t.rn.stopAtRound === true);
  const offRound = all.filter((t) => t.rn.stopAtRound !== true);
  console.log(`  stop ON handle (±${AT_ROUND_PTS}pt):   ${bandRow("stop @round", onRound)}`);
  console.log(`  stop OFF handle:              ${bandRow("stop off-round", offRound)}`);

  const bands: { label: string; lo: number; hi: number }[] = [
    { label: "|stop dist| 0–1 pt (ON)", lo: 0, hi: 1 },
    { label: "|stop dist| 1–2.5", lo: 1, hi: 2.5 },
    { label: "|stop dist| 2.5–5", lo: 2.5, hi: 5 },
    { label: "|stop dist| 5–12.5", lo: 5, hi: 12.5 },
    { label: "|stop dist| 12.5–25 (far)", lo: 12.5, hi: 25 },
  ];
  for (const b of bands) {
    const tt = all.filter((t) => {
      const d = Math.abs(t.rn.stopToRound50 ?? Infinity);
      return d >= b.lo && d < b.hi;
    });
    console.log(`  ${bandRow(b.label, tt)}`);
  }
  console.log();

  const cross = all.filter((t) => t.rn.targetCrossRound === true);
  const noCross = all.filter((t) => t.rn.targetCrossRound !== true);
  console.log(`  target crosses a handle:      ${bandRow("target crosses", cross)}`);
  console.log(`  target does not:              ${bandRow("no cross", noCross)}`);
  const entryOn = all.filter((t) => t.rn.entryAtRound === true);
  const entryOff = all.filter((t) => t.rn.entryAtRound !== true);
  console.log(`  entry on a handle:            ${bandRow("entry @round", entryOn)}`);
  console.log(`  entry off:                    ${bandRow("entry off-round", entryOff)}`);
  console.log();

  console.log(`PHASE 3 — Naso's remedy: widen the ON-handle stops ${PAD_PTS}pt off the number (real re-score)`);
  console.log(`  ON-handle stops, base stop:   ${bandRow("base", onRound)}`);
  console.log(`  ON-handle stops, padded stop: ${bandRow("padded", padded)}`);
  const baseStats = stats(onRound);
  const padStats = stats(padded);
  const deltaNet = padStats.net - baseStats.net;
  console.log(
    `  delta: net ${deltaNet >= 0 ? "+" : ""}${deltaNet.toFixed(0)} pts · WR ${baseStats.wr.toFixed(1)}% → ${padStats.wr.toFixed(1)}% ` +
      `· stops ${baseStats.stops} → ${padStats.stops} (${padStats.stops <= baseStats.stops ? "-" : "+"}${Math.abs(padStats.stops - baseStats.stops)})`,
  );
  console.log(
    `  verdict vs the global pad sweep (stopRunStudy: pads degrade monotonically): ` +
      `the ON-round subset is special ONLY if this delta is positive and larger than the 1pt-pad delta on all trades.`,
  );

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * T1 core quality for the full cohort (no train/test split in this
   * study), T4 prop viability, five-slot verdict. ---- */
  const engineTrades = all.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  const allCore = coreStats(engineTrades);
  console.log(renderT1([{ label: "all", stats: allCore }]));
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: allCore.netPts > 0 && allCore.expR > 0 ? "real" : "absent",
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
