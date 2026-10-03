/* ------------------------------------------------------------------ *
 * Sizing cap study — derive the max realistic contract cap.
 *
 * The live sizing: contracts = floor($170 ÷ (riskPts × $2)), risk floor
 * 3 pts, cap 30 micros. At risk 3 the cap never binds (28 contracts),
 * so "cap at 15" is only meaningful if it corresponds to a realistic
 * minimum stop. This study measures:
 *
 *   phase 1 — risk buckets: where does the edge live, and where do
 *             "ridiculously small" stops start hurting? (WR/PF/expR per
 *             risk bucket on the combined momentum + expansion stream)
 *   phase 2 — cap sweep {30, 24, 20, 17, 15, 12, 10} with live tiers,
 *             through the day-level metrics (total, worst day, dayVol,
 *             >$900 days, avg contracts, % of trades at the cap)
 *   phase 3 — min-risk floor sweep {3, 4, 5, 6, 8}: drop trades whose
 *             stop is below the floor (the detection-level lever), same
 *             metrics, cap 30
 *
 * Sequential one-position-at-a-time across both families, first-touch,
 * 0.5pt cost, $0.95/side commissions, 60-bar exit.
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/sizingCapStudy.ts [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  closeOf,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const BUDGET = 170;
const COMM_PER_SIDE = 0.95;
const TIERS = [
  { threshold: 600, multiplier: 1 / 3 },
  { threshold: 300, multiplier: 2 / 3 },
];

type Scored = { date: string; entryIdx: number; risk: number; pnl: number; fam: "mom" | "exp" };

async function main() {
  const offline = process.argv.includes("--offline");
  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  console.log(`sizing-cap study · ${dates.length} sessions`);
  const t0 = Date.now();

  /** score one session sequentially; when widenFloor > 0, structural stops
   *  tighter than it are WIDENED to the floor (stop = entry ∓ floor, 1R
   *  target from the widened stop) instead of being skipped. */
  // the historical baseline configs (minRisk 3) — the skip/widen variants are
  // applied in the METRICS layer so all variants share one honest trade stream
  const MOM_BASE = { ...MOM_PROD, minRiskPts: 3, maxRiskPts: 30, riskFloorPts: 0 };
  const EXP_BASE = { ...EXP_PROD, minRiskPts: 3, riskFloorPts: 0 };

  function detectSession(minutes: MomMinute[]): MomentumSignal[] {
    return [...detectMomentum(minutes, MOM_BASE), ...detectExpansionScalp(minutes, EXP_BASE)].sort(
      (a, b) => a.entryIdx - b.entryIdx,
    );
  }

  function scoreSignals(minutes: MomMinute[], sigs: MomentumSignal[], date: string, widenFloor: number): Scored[] {
    const out: Scored[] = [];
    let openUntil = -1;
    for (const s of sigs) {
      if (s.entryIdx <= openUntil) continue;
      const dir = s.dir === "long" ? 1 : -1;
      let risk = Math.abs(s.entry - s.stop);
      if (!(risk > 0)) continue;
      let stop = s.stop;
      if (widenFloor > 0 && risk < widenFloor) {
        stop = s.entry - dir * widenFloor;
        risk = widenFloor;
      }
      const target = s.entry + dir * 1 * risk;
      const start = s.entryIdx + 1;
      const end = Math.min(minutes.length - 1, s.entryIdx + HOLD_BARS);
      if (start > end) continue;
      let hit: "stop" | "target" | "time" = "stop";
      let exit = stop;
      let heldBars = 0;
      for (let j = start; j <= end; j++) {
        const b = minutes[j];
        const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
        const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
        if (stopHit) {
          heldBars = j - s.entryIdx;
          break;
        }
        if (tgtHit) {
          exit = target;
          hit = "target";
          heldBars = j - s.entryIdx;
          break;
        }
      }
      if (hit === "stop" && heldBars === end - s.entryIdx) {
        const stopHitLast = dir > 0 ? minutes[end].low <= stop : minutes[end].high >= stop;
        if (!stopHitLast) {
          hit = "time";
          exit = (minutes[end].high + minutes[end].low) / 2;
        }
      }
      out.push({ date, entryIdx: s.entryIdx, risk, pnl: (exit - s.entry) * dir - COST_PTS, fam: s.kind === "expansion" ? "exp" : "mom" });
      openUntil = s.entryIdx + heldBars;
    }
    return out;
  }

  const FLOORS = [0, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.5, 6, 7, 8];
  const streams = new Map<number, Scored[]>(FLOORS.map((f) => [f, []]));
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      const sigs = detectSession(minutes);
      for (const f of FLOORS) streams.get(f)!.push(...scoreSignals(minutes, sigs, date, f));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  const all = streams.get(0)!; // structural stops (widenFloor 0)
  const widened = streams.get(4)!; // the 4-pt floor stream (phase 6)
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${all.length} structural trades · ${widened.length} widened(4) trades\n`);

  /* ---- phase 1: risk buckets (sizing-independent, points) ---- */
  const edges: Array<[number, number]> = [
    [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 10], [10, 12], [12, 15], [15, 20], [20, 30],
  ];
  console.log("PHASE 1 — edge by stop width (points, before sizing):");
  console.log(`${"risk pts".padStart(9)} ${"n".padStart(6)} ${"share".padStart(6)} ${"wr".padStart(7)} ${"pf".padStart(7)} ${"expR".padStart(6)} ${"net pts".padStart(9)}`);
  for (const [lo, hi] of edges) {
    const t = all.filter((x) => x.risk >= lo && x.risk < hi);
    const n = t.length;
    if (!n) continue;
    const wins = t.filter((x) => x.pnl > 0);
    const gw = t.reduce((a, x) => a + Math.max(0, x.pnl), 0);
    const gl = t.reduce((a, x) => a + Math.max(0, -x.pnl), 0);
    const net = t.reduce((a, x) => a + x.pnl, 0);
    console.log(
      `${`${lo}-${hi}`.padStart(9)} ${String(n).padStart(6)} ${`${((n / all.length) * 100).toFixed(1)}%`.padStart(6)} ${`${((wins.length / n) * 100).toFixed(1)}%`.padStart(7)} ${`${(gl > 0 ? gw / gl : Infinity).toFixed(2)}`.padStart(7)} ${`${(net / n / (t.reduce((a, x) => a + x.risk, 0) / n)).toFixed(2)}`.padStart(6)} ${net.toFixed(0).padStart(9)}`,
    );
  }

  console.log("\nPHASE 1b — the 3–4 pt weak bucket, per family:");
  for (const fam of ["mom", "exp"] as const) {
    for (const [lo, hi] of [[3, 4], [4, 5]] as Array<[number, number]>) {
      const t = all.filter((x) => x.fam === fam && x.risk >= lo && x.risk < hi);
      const n = t.length;
      if (!n) continue;
      const wins = t.filter((x) => x.pnl > 0).length;
      const gw = t.reduce((a, x) => a + Math.max(0, x.pnl), 0);
      const gl = t.reduce((a, x) => a + Math.max(0, -x.pnl), 0);
      console.log(
        `  ${fam.padEnd(4)} ${lo}-${hi}pts  n=${String(n).padStart(4)}  wr=${((wins / n) * 100).toFixed(1).padStart(5)}%  pf=${(gl > 0 ? gw / gl : Infinity).toFixed(2).padStart(5)}`,
      );
    }
  }

  /* ---- phase 2 + 3: cap sweep and min-risk sweep through day metrics ---- */
  type DayRow = { total: number; med: number; worst: number; vol: number; over900: number; avgC: number; cappedShare: number; n: number; wr: number; avgPnl: number };
  function dayMetricsStream(stream: Scored[], cap: number, minRisk: number, maxRisk = 30): DayRow {
    const byDay = new Map<string, { pnl: number; contracts: number[]; n: number }>();
    let wins = 0;
    let totalTrades = 0;
    for (const t of stream) {
      if (t.risk < minRisk || t.risk > maxRisk) continue;
      const contracts = Math.max(1, Math.min(cap, Math.floor(BUDGET / (t.risk * 2))));
      totalTrades++;
      const usdRaw = t.pnl * contracts * 2 - 2 * contracts * COMM_PER_SIDE;
      if (usdRaw > 0) wins++;
      const d = byDay.get(t.date) ?? { pnl: 0, contracts: [], n: 0 };
      // live tiers on the running day P&L
      let mult = 1;
      for (const tr of TIERS) if (d.pnl >= tr.threshold) { mult = tr.multiplier; break; }
      const c = Math.max(1, Math.round(contracts * mult));
      const usd = t.pnl * c * 2 - 2 * c * COMM_PER_SIDE;
      d.pnl += usd;
      d.contracts.push(c);
      d.n++;
      byDay.set(t.date, d);
    }
    const days = [...byDay.values()];
    const totals = days.map((d) => d.pnl).sort((a, b) => a - b);
    const mean = totals.reduce((a, b) => a + b, 0) / Math.max(1, totals.length);
    const vol = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, totals.length));
    const allC = days.flatMap((d) => d.contracts);
    return {
      total: totals.reduce((a, b) => a + b, 0),
      med: totals[Math.floor(totals.length / 2)] ?? 0,
      worst: totals[0] ?? 0,
      vol,
      over900: totals.filter((d) => d > 900).length,
      avgC: allC.length ? allC.reduce((a, b) => a + b, 0) / allC.length : 0,
      cappedShare: allC.length ? (allC.filter((c) => c >= cap).length / allC.length) * 100 : 0,
      n: days.reduce((a, d) => a + d.n, 0),
      wr: totalTrades ? (wins / totalTrades) * 100 : 0,
      avgPnl: totalTrades ? totals.reduce((a, b) => a + b, 0) / totalTrades : 0,
    };
  }
  const dayMetrics = (cap: number, minRisk: number, maxRisk = 30): DayRow => dayMetricsStream(all, cap, minRisk, maxRisk);
  const fmtRow = (label: string, r: DayRow, withWr = false) =>
    `${label.padEnd(16)} ${String(r.n).padStart(6)} ${`+$${Math.round(r.total).toLocaleString("en-US")}`.padStart(11)} ${withWr ? `${r.wr.toFixed(1).padStart(5)}%` : ""} ${`$${Math.round(r.med)}`.padStart(7)} ${`−$${Math.abs(Math.round(r.worst))}`.padStart(8)} ${`$${Math.round(r.vol)}`.padStart(7)} ${String(r.over900).padStart(6)} ${r.avgC.toFixed(1).padStart(6)} ${`${r.cappedShare.toFixed(0)}%`.padStart(7)} ${(r.vol > 0 ? r.total / r.vol : 0).toFixed(0).padStart(6)}`;

  console.log("\nPHASE 2 — contract-cap sweep (live tiers on, minRisk 3):");
  console.log(`${"cap".padEnd(16)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"med".padStart(7)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${">900d".padStart(6)} ${"avgC".padStart(6)} ${"at cap".padStart(7)} ${"$/vol".padStart(6)}`);
  for (const cap of [30, 24, 20, 17, 15, 12, 10]) console.log(fmtRow(`cap ${cap}`, dayMetrics(cap, 3)));

  console.log("\nPHASE 3 — min-risk floor sweep (cap 30, live tiers on):");
  console.log(`${"minRisk".padEnd(16)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"med".padStart(7)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${">900d".padStart(6)} ${"avgC".padStart(6)} ${"at cap".padStart(7)} ${"$/vol".padStart(6)}`);
  for (const mr of [3, 4, 5, 6, 8]) console.log(fmtRow(`minRisk ${mr}`, dayMetrics(30, mr)));

  console.log("\nPHASE 4 — cap × minRisk combined (the derived candidates):");
  for (const [cap, mr] of [[15, 3], [17, 5], [14, 6], [10, 8]] as Array<[number, number]>) {
    console.log(fmtRow(`cap${cap}+min${mr}`, dayMetrics(cap, mr)));
  }

  console.log("\nPHASE 5 — stop-band sweep (cap 30 untouched; skip trades outside the band):");
  console.log(`${"band [min,max]".padEnd(16)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"med".padStart(7)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${">900d".padStart(6)} ${"avgC".padStart(6)} ${"at cap".padStart(7)} ${"$/vol".padStart(6)}`);
  for (const [mn, mx] of [[3, 30], [4, 30], [4, 20], [4, 15], [4, 12], [5, 15], [5, 12]] as Array<[number, number]>) {
    console.log(fmtRow(`[${mn},${mx}]`, dayMetrics(30, mn, mx)));
  }

  console.log("\nPHASE 6 — widen-to-floor vs skip vs structural (cap 30, tiers on):");
  console.log(`${"variant".padEnd(16)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"med".padStart(7)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${">900d".padStart(6)} ${"avgC".padStart(6)} ${"at cap".padStart(7)} ${"$/vol".padStart(6)}`);
  console.log(fmtRow("structural (3+)", dayMetricsStream(all, 30, 3, 30)));
  console.log(fmtRow("skip <4", dayMetricsStream(all, 30, 4, 30)));
  console.log(fmtRow("WIDEN <4→4", dayMetricsStream(widened, 30, 3, 30)));

  console.log("\nPHASE 7 — widen-floor sweep (where does the return peak?):");
  console.log(`${"floor".padEnd(16)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"wr".padStart(6)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${">900d".padStart(6)} ${"avgC".padStart(6)} ${"at cap".padStart(7)} ${"$/vol".padStart(6)}`);
  let best = { floor: 0, total: -Infinity };
  for (const f of FLOORS) {
    const r = dayMetricsStream(streams.get(f)!, 30, 3, 30);
    if (f > 0 && r.total > best.total) best = { floor: f, total: r.total };
    console.log(fmtRow(f === 0 ? "off (structural)" : `floor ${f}`, r, true));
  }
  console.log(`\n  → best TOTAL at floor ${best.floor} (+$${Math.round(best.total).toLocaleString("en-US")})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
