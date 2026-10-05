/* ------------------------------------------------------------------ *
 * Retrace slippage study — what does entry slippage on the expansion
 * retrace cost, and how does the broker-limit execution compare?
 *
 * Replays the SAME expansion-retrace machinery as entryQualityStudy's
 * "exp retrace" cell (5 bars, 1 pt behind the signal close, fill at the
 * limit or better on a gap-through, brackets anchored at the fill,
 * ladder exits, live sizing/tiers/give-back) and then sweeps an
 * ADVERSE offset on top of the fill:
 *
 *   offset 0.0   = a resting broker limit at the retrace level (the
 *                  backtest's own model — the faithful execution)
 *   offset 0.5…3 = the market-order path when the broker fill slips
 *                  that far past the tape fill (live market orders
 *                  carry this risk; the 2026-10-04 reopen slip was
 *                  14.75 pts — off the chart, and the quote gate now
 *                  refuses anything beyond ~3)
 *
 * Also reports the W→L flips each offset causes vs the 0.0 baseline.
 *
 * Run from web/ (cache-first; export GC_REMOTE_URL for the manifest):
 *   node --import ../scripts/ts-loader.mjs scripts/retraceSlippageStudy.ts --offline
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { scoreScaleOut } from "../lib/runner";
import { detectExpansionScalp, EXP_PROD, midOf, type MomMinute } from "../lib/momentum";

const CONCURRENCY = 8;
const COST = 0.5; // pts round-trip slippage+cost inside the scorer
const COMM_PER_SIDE = 0.95;
const RETRACE_PTS = 1.0;
const RETRACE_BARS = 5;
const RECOVER_BARS = 10;
const TIERS = [
  { threshold: 600, multiplier: 1 / 3 },
  { threshold: 300, multiplier: 2 / 3 },
];
const GIVEBACK = { pct: 0.5, floor: 250 };
const OFFSETS = [0, 0.5, 1.0, 2.0, 3.0];

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

const sizeOf = (riskPts: number): number =>
  Math.max(1, Math.min(30, Math.floor(170 / (riskPts * 2))));

const tierOf = (dayPnl: number): number => {
  for (const t of TIERS) if (dayPnl >= t.threshold) return t.multiplier;
  return 1;
};

type Trade = {
  date: string;
  idx: number;
  dir: 1 | -1;
  pnlPts: number;
  pnlUsd: number;
  drift: number;
};

/** the expansion-retrace fill (limit-or-better), offset-swept */
function runOffsets(date: string, minutes: MomMinute[], offsets: number[]) {
  const out = offsets.map(() => ({ trades: [] as Trade[], rejected: 0 }));
  const sigs = detectExpansionScalp(minutes, EXP_PROD).sort((a, b) => a.entryIdx - b.entryIdx);
  for (const off of offsets) {
    let dayPnl = 0;
    let dayPeak = 0;
    let halt = false;
    let openUntil = -1;
    for (const s of sigs) {
      const dir = s.dir === "long" ? 1 : -1;
      /* 1) retrace fill (same rule as entryQualityStudy's exp cell) */
      if (s.entryIdx + 1 >= minutes.length) {
        out[offsets.indexOf(off)].rejected++;
        continue;
      }
      const level = s.entry - dir * RETRACE_PTS;
      let touched = -1;
      for (let j = s.entryIdx + 1; j <= Math.min(minutes.length - 1, s.entryIdx + RETRACE_BARS); j++) {
        const b = minutes[j];
        if (dir > 0 ? b.low <= level : b.high >= level) {
          touched = j;
          break;
        }
      }
      if (touched < 0) {
        out[offsets.indexOf(off)].rejected++;
        continue;
      }
      const b = minutes[touched];
      let fill = dir > 0 ? Math.min(openOf(b), level) : Math.max(openOf(b), level);
      fill = fill + dir * off; // the adverse slip under test

      /* 2) flat rule */
      if (touched <= openUntil) continue;

      /* 3) risk anchor (brackets from the fill, like the live REST path) */
      const risk = Math.abs(s.entry - s.stop);
      if (!(risk > 0)) continue;
      const stop = fill - dir * risk;

      /* 4) ladder exit from the fill bar */
      const t = scoreScaleOut(minutes, fill, stop, dir, touched - 1, { maxBars: 60, cost: COST });
      if (!t) continue;
      if (halt) continue;

      /* 5) dollars: live sizing + tiers + commissions */
      let contracts = sizeOf(risk);
      const mult = tierOf(dayPnl);
      if (mult < 1) contracts = Math.max(1, Math.round(contracts * mult));
      const pnlUsd = t.pnl * contracts * 2 - 2 * contracts * COMM_PER_SIDE;

      out[offsets.indexOf(off)].trades.push({
        date,
        idx: s.entryIdx,
        dir,
        pnlPts: t.pnl,
        pnlUsd,
        drift: (fill - s.entry) * dir,
      });
      dayPnl += pnlUsd;
      dayPeak = Math.max(dayPeak, dayPnl);
      openUntil = touched - 1 + t.heldBars;
      if (dayPeak > GIVEBACK.floor) {
        const limit = Math.max(GIVEBACK.floor, GIVEBACK.pct * dayPeak);
        if (dayPnl <= dayPeak - limit) halt = true;
      }
    }
  }
  return out;
}

type Summary = {
  n: number;
  wins: number;
  losses: number;
  wr: number;
  net: number;
  pf: number;
  expUsd: number;
  worstDay: number;
  medianDay: number;
  avgAdvDrift: number;
};

function summarize(trades: Trade[]): Summary {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const gw = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));
  const net = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnlUsd);
  const days = [...byDay.values()].sort((a, b) => a - b);
  const adv = trades.filter((t) => t.drift < 0).map((t) => -t.drift);
  const decided = wins.length + losses.length;
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr: decided ? (wins.length / decided) * 100 : 0,
    net,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    expUsd: trades.length ? net / trades.length : 0,
    worstDay: days[0] ?? 0,
    medianDay: days.length ? days[Math.floor(days.length / 2)] : 0,
    avgAdvDrift: adv.length ? adv.reduce((a, b) => a + b, 0) / adv.length : 0,
  };
}

const fmtUsd = (v: number): string => (v >= 0 ? "+$" : "−$") + Math.abs(Math.round(v)).toLocaleString("en-US");

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : undefined;
  const splitArg = argv.indexOf("--split");
  const split = splitArg >= 0 ? argv[splitArg + 1] : "2026-01-01";

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`retrace-slippage study · ${dates.length} sessions · split ${split}\n`);
  console.log("model: expansion retrace (5 bars, 1 pt behind signal close), fill at limit-or-better,");
  console.log("then +offset adverse pts (0 = broker resting limit = the backtest model)\n");

  const accum = OFFSETS.map((off) => ({ off, trades: [] as Trade[], rejected: 0 }));
  const t0 = Date.now();
  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const res = runOffsets(date, minutes, OFFSETS);
      for (let k = 0; k < OFFSETS.length; k++) {
        accum[k].trades.push(...res[k].trades);
        accum[k].rejected += res[k].rejected;
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const sums = accum.map((a) => ({ ...a, s: summarize(a.trades) }));
  const base = sums[0];
  const keyOf = (t: Trade): string => `${t.date}|${t.idx}|${t.dir}`;

  console.log("offset (adverse pts) |    n   W/L    WR%      net      pf    $/trade   medDay  worstDay");
  console.log("--------------------------------------------------------------------------------------");
  for (const a of sums) {
    const pf = Number.isFinite(a.s.pf) ? a.s.pf.toFixed(2) : "inf";
    console.log(
      `${String(a.off).padStart(5)}pts            | ${String(a.s.n).padStart(4)} ${String(a.s.wins).padStart(4)}/${String(a.s.losses).padStart(2)} ${a.s.wr.toFixed(1).padStart(5)}% ${fmtUsd(a.s.net).padStart(9)} ${`${pf}`.padStart(6)} ${fmtUsd(a.s.expUsd).padStart(9)} ${fmtUsd(a.s.medianDay).padStart(8)} ${fmtUsd(a.s.worstDay).padStart(9)}`,
    );
  }

  console.log("\nleak vs the broker-limit baseline (0.0):");
  console.log("offset |   Δnet vs 0.0    Δ$/trade   W→L flips   L→W flips");
  console.log("-------------------------------------------------------------");
  for (const a of sums.slice(1)) {
    const dNet = a.s.net - base.s.net;
    const baseByKey = new Map(base.trades.map((t) => [keyOf(t), t]));
    let flips = 0;
    let unflips = 0;
    for (const t of a.trades) {
      const b = baseByKey.get(keyOf(t));
      if (!b) continue;
      if (b.pnlUsd > 0 && t.pnlUsd <= 0) flips++;
      if (b.pnlUsd <= 0 && t.pnlUsd > 0) unflips++;
    }
    console.log(
      `${String(a.off).padStart(4)}pts | ${fmtUsd(dNet).padStart(12)}  ${fmtUsd(a.s.expUsd - base.s.expUsd).padStart(10)}   ${String(flips).padStart(7)}     ${String(unflips).padStart(7)}`,
    );
  }

  console.log("\nTRAIN (< split) / TEST (≥ split) net + WR:");
  for (const a of sums) {
    const tr = summarize(a.trades.filter((t) => t.date < split));
    const te = summarize(a.trades.filter((t) => t.date >= split));
    console.log(
      `${String(a.off).padStart(5)}pts | TRAIN n=${String(tr.n).padStart(5)} wr=${tr.wr.toFixed(1).padStart(5)}% net=${fmtUsd(tr.net).padStart(10)}  |  TEST n=${String(te.n).padStart(5)} wr=${te.wr.toFixed(1).padStart(5)}% net=${fmtUsd(te.net).padStart(10)}`,
    );
  }
  console.log(`\nrejected (retrace never touched): ${base.rejected} of the expansion signals`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
