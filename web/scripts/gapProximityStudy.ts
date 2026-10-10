/* ------------------------------------------------------------------ *
 * Gap-proximity study — the falsification test of Richie Naso's gap
 * claims (Words of Rizdom, 2024-12):
 *
 *   "algorithms love to come back to gaps… most of the time 50% of
 *   that gap is filled, if not all of it."
 *
 * Phase 1 measures the BASE RATES over the whole archive (every gap,
 * not just signal bars): how many gaps per session, their size, and
 * how often each reaches 50% / 100% fill and how fast — is "gaps get
 * half-filled" even true on NQ 1-minute data?
 *
 * Phase 2 measures whether gaps AHEAD of the momentum-card entry
 * matter for outcomes: gapInPath (an unfilled gap inside the
 * entry→target window), nearest-unfilled-gap distance bands, and the
 * recent-gap-fill regime flag. WR / PF / net per bucket, sequential
 * first-touch replay, 0.5 pt cost, 60-bar exit — the same harness as
 * stopRunStudy.ts. Features come from lib/gapTracker.ts computed on
 * the bars known at entry (no lookahead: the inventory is sliced at
 * the entry bar).
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/gapProximityStudy.ts [--max N] [--offline]
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
import { gapInventory, gapChips, type Gap, type GapChips } from "../lib/gapTracker";
// consolidated engine: canonical scorer + standard T1/T4 + verdict
import { scoreTrade as engineScoreTrade, coreStats, propViability, renderT1, renderT4, renderVerdict } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;

/* ---------------- gap base rates (Phase 1) ---------------- */

type GapStat = { date: string; gap: Gap; fillBar: number | null }; // fillBar = bars from the gap to half-fill (null = never)

function collectGaps(date: string, minutes: MomMinute[]): GapStat[] {
  const out: GapStat[] = [];
  const gaps = gapInventory(minutes);
  for (const g of gaps) {
    let fillBar: number | null = null;
    for (let j = g.idx + 1; j < minutes.length; j++) {
      const b = minutes[j];
      const lo = Math.max(g.bottom, b.low);
      const hi = Math.min(g.top, b.high);
      if (hi > lo) {
        // crude first-touch estimate of half-fill: the bar that first
        // re-trades into the zone at least halfway
        const mid = (g.bottom + g.top) / 2;
        const crossed = b.low <= mid && b.high >= mid;
        if (crossed) {
          fillBar = j - g.idx;
          break;
        }
      }
    }
    out.push({ date, gap: g, fillBar });
  }
  return out;
}

/* ---------------- trade replay (Phase 2) ---------------- */

type Scored = {
  date: string;
  hourET: number;
  kind: "flush" | "expansion";
  dir: "long" | "short";
  risk: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  g: GapChips["features"];
};

function scoreTrade(minutes: MomMinute[], sig: MomentumSignal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  // the consolidated engine's canonical scorer (pessimistic stop-first,
  // 0.5 pt cost, 60-bar time exit, midpoint close). Momentum signals
  // always satisfy stop < entry < target, so the geometry validation
  // never drops a trade the old loop would have scored.
  const sc = engineScoreTrade(
    minutes,
    { dir, entry: sig.entry, stop: sig.stop, target: sig.target, entryIdx: sig.entryIdx, risk: sig.risk },
    { costPts: COST_PTS, holdBars: HOLD_BARS },
  );
  if (!sc) return null;

  // gap features from the bars known at entry only (no lookahead)
  const g = gapChips(minutes.slice(0, sig.entryIdx + 1), sig).features;
  return { date, hourET: sig.hourET, kind: sig.kind, dir: sig.dir, risk: sc.risk, pnl: sc.pnl, hit: sc.hit, g };
}

function replay(minutes: MomMinute[], sigs: MomentumSignal[], date: string): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const sc = scoreTrade(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.entryIdx + HOLD_BARS;
  }
  return out;
}

/* ---------------- aggregation ---------------- */

function stats(tt: Scored[]) {
  // the standard metric set (identical WR/PF/net formulas)
  const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return { n: s.n, wr: s.wr, pf: s.pf, net: s.netPts };
}

function fmtRow(s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}%  pf=${pf.padStart(5)}  net=${s.net.toFixed(0).padStart(7)}`;
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
  console.log(`gap-proximity study · ${dates.length} sessions · sequential, first-touch, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit`);

  const allGaps: GapStat[] = [];
  const trades: Scored[] = [];
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
      allGaps.push(...collectGaps(date, minutes));
      trades.push(...replay(minutes, detectMomentum(minutes, MOM_PROD), date));
      trades.push(...replay(minutes, detectExpansionScalp(minutes, EXP_PROD), date));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  console.log("PHASE 1 — gap base rates (Naso: '50% of the gap is filled, if not all')");
  {
    const n = allGaps.length;
    const half = allGaps.filter((x) => x.gap.filledHalf);
    const full = allGaps.filter((x) => x.gap.filledFull);
    const perSession = n / Math.max(1, loaded);
    const sizes = allGaps.map((x) => x.gap.size).sort((a, b) => a - b);
    const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] ?? 0;
    const fillTimes = half.filter((x) => x.fillBar !== null).map((x) => x.fillBar as number);
    const medFill = fillTimes.length ? fillTimes.sort((a, b) => a - b)[Math.floor(fillTimes.length / 2)] : NaN;
    console.log(
      `  gaps: ${n} (${perSession.toFixed(2)}/session) · half-filled: ${half.length} (${((half.length / Math.max(1, n)) * 100).toFixed(1)}%) · ` +
        `fully filled: ${full.length} (${((full.length / Math.max(1, n)) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  size (pts): median ${q(0.5).toFixed(2)} · p90 ${q(0.9).toFixed(2)} · max ${(sizes[sizes.length - 1] ?? 0).toFixed(2)} · ` +
        `median bars to half-fill: ${Number.isFinite(medFill) ? medFill : "—"}`,
    );
    const bands: { label: string; lo: number; hi: number }[] = [
      { label: "0.25–1 pt", lo: 0.25, hi: 1 },
      { label: "1–2.5", lo: 1, hi: 2.5 },
      { label: "2.5–5", lo: 2.5, hi: 5 },
      { label: "5–15", lo: 5, hi: 15 },
      { label: ">15", lo: 15, hi: Infinity },
    ];
    for (const b of bands) {
      const sel = allGaps.filter((x) => x.gap.size >= b.lo && x.gap.size < b.hi);
      const h = sel.filter((x) => x.gap.filledHalf).length;
      const f = sel.filter((x) => x.gap.filledFull).length;
      console.log(
        `    ${b.label.padEnd(10)} n=${String(sel.length).padStart(5)}  half=${sel.length ? ((h / sel.length) * 100).toFixed(0).padStart(3) : "  0"}%  ` +
          `full=${sel.length ? ((f / sel.length) * 100).toFixed(0).padStart(3) : "  0"}%`,
      );
    }
    const down = allGaps.filter((x) => x.gap.dir === "down");
    const up = allGaps.filter((x) => x.gap.dir === "up");
    const halfPct = (xs: GapStat[]) => (xs.length ? ((xs.filter((x) => x.gap.filledHalf).length / xs.length) * 100).toFixed(1) : "—");
    console.log(`    gap up ${up.length} (half-filled ${halfPct(up)}%) · gap down ${down.length} (half-filled ${halfPct(down)}%)`);
    console.log();
  }

  console.log("PHASE 2 — do gaps ahead of the entry move outcomes?");
  console.log(`  all:                    ${fmtRow(stats(trades))}`);
  const inPath = trades.filter((t) => t.g.gapInPath === true);
  const noPath = trades.filter((t) => t.g.gapInPath !== true);
  console.log(`  unfilled gap in path:   ${fmtRow(stats(inPath))}`);
  console.log(`  no gap in path:         ${fmtRow(stats(noPath))}`);

  const distBands: { label: string; keep: (d: number | null | undefined) => boolean }[] = [
    { label: "nearest gap 0 (inside)", keep: (d) => d !== null && d !== undefined && d <= 0 },
    { label: "nearest gap ≤10pt", keep: (d) => d !== null && d !== undefined && d > 0 && d <= 10 },
    { label: "nearest gap 10–30pt", keep: (d) => d !== null && d !== undefined && d > 10 && d <= 30 },
    { label: "nearest gap >30pt", keep: (d) => d !== null && d !== undefined && d > 30 },
    { label: "no unfilled gap ahead", keep: (d) => d === null || d === undefined },
  ];
  for (const b of distBands) {
    const sel = trades.filter((t) => b.keep(t.g.nearestUnfilledGap));
    console.log(`  ${b.label.padEnd(24)} ${fmtRow(stats(sel))}`);
  }
  const regime = trades.filter((t) => t.g.recentGapFill === true);
  const noRegime = trades.filter((t) => t.g.recentGapFill !== true);
  console.log(`  gap filled in last 30m: ${fmtRow(stats(regime))}`);
  console.log(`  no recent fill:         ${fmtRow(stats(noRegime))}`);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * T1 core quality for the full cohort (no train/test split in this
   * study), T4 prop viability, five-slot verdict. ---- */
  const engineTrades = trades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
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
