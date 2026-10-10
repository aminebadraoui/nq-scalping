/* ------------------------------------------------------------------ *
 * Expansion-family breakout study — is the huge-bar expansion scalp
 * (EXP_PROD) structurally weaker than its playbook numbers (78.4% WR,
 * PF 3.14 over 568 sessions), or was the 2026-10-01 session's 1W/4L
 * (PF 0.39) just variance?
 *
 * Replays detectExpansionScalp(EXP_PROD) over the full archive with the
 * live plan shapes (1R target, structural stop, 60-bar first-touch,
 * 0.5 pt cost, one position at a time) and breaks the result down by
 * year, side, and hour bucket — the session's expansion losses were
 * all globex tickets.
 *
 *   node --import ../scripts/ts-loader.mjs scripts/expansionStudy.ts \
 *     [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectExpansionScalp, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { hourBucketOf } from "../lib/tradeStats";
import {
  coreStats,
  scoreTrade,
  scoreSequential,
  wilson95,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
} from "../lib/backtestEngine";

const HOLD_BARS = 60;
const SPLIT = "2026-01-01";

type T = {
  date: string;
  hourET: number;
  mm: number;
  dir: "long" | "short";
  bucket: string;
  pnlPts: number;
  riskPts: number;
  hit: "stop" | "target" | "time";
  heldBars?: number;
  rangeR: number;
  deltaFrac: number;
};

function replay(minutes: MomMinute[], sigs: MomentumSignal[]): T[] {
  // one-trade-at-a-time over the FULL 60-bar window (the local convention)
  return scoreSequential(
    sigs,
    (s): T | null => {
      const dir = s.dir === "long" ? 1 : -1;
      const risk = Math.abs(s.entry - s.stop);
      const sc = scoreTrade(minutes, { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk });
      if (!sc) return null;
      const mm = Number(s.t.slice(3, 5));
      return {
        date: s.d,
        hourET: s.hourET,
        mm,
        dir: s.dir,
        bucket: hourBucketOf(`${String(s.hourET).padStart(2, "0")}:${String(mm).padStart(2, "0")}`),
        pnlPts: sc.pnl,
        riskPts: risk,
        hit: sc.hit,
        heldBars: sc.heldBars,
        rangeR: s.flushRangeR, // expansion bar range ratio (recorded by the detector)
        deltaFrac: Math.abs(s.flushFrac),
      };
    },
    { occupy: "full", window: HOLD_BARS },
  );
}

function stats(tt: T[]) {
  const st = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
  // legacy wr excludes zero-pnl trades from the denominator (decided);
  // the engine counts them as losses — pf/net/exp formulas are identical
  const decided = tt.filter((t) => t.pnlPts !== 0).length;
  const stops = tt.filter((t) => t.hit === "stop");
  return {
    n: st.n,
    wr: decided ? (st.wins / decided) * 100 : 0,
    pf: st.pf,
    net: st.netPts,
    exp: st.expPts,
    stopShare: st.n ? (stops.length / st.n) * 100 : 0,
  };
}

function fmtRow(label: string, s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : " inf";
  return `${label.padEnd(18)} | n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} net=${s.net.toFixed(0).padStart(8)} exp=${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(5)} stops=${s.stopShare.toFixed(0).padStart(3)}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : undefined;

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`expansion breakout · ${dates.length} sessions · EXP_PROD · first-touch 60-bar 0.5pt`);

  const all: T[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { minutes } of sessions) {
      if (!minutes) continue;
      all.push(...replay(minutes, detectExpansionScalp(minutes, EXP_PROD)));
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${all.length} expansion trades\n`);

  console.log("=== overall / year / side / train-test ===");
  console.log(`  ${fmtRow("ALL", stats(all))}`);
  for (const y of ["2024", "2025", "2026"]) {
    console.log(`  ${fmtRow(y, stats(all.filter((t) => t.date.startsWith(y))))}`);
  }
  console.log(`  ${fmtRow("long", stats(all.filter((t) => t.dir === "long")))}`);
  console.log(`  ${fmtRow("short", stats(all.filter((t) => t.dir === "short")))}`);
  console.log(`  ${fmtRow("TRAIN <2026", stats(all.filter((t) => t.date < SPLIT)))}`);
  console.log(`  ${fmtRow("TEST ≥2026", stats(all.filter((t) => t.date >= SPLIT)))}`);

  console.log("\n=== hour bucket ===");
  const buckets = [...new Set(all.map((t) => t.bucket))].sort();
  for (const b of buckets) {
    console.log(`  ${fmtRow(b, stats(all.filter((t) => t.bucket === b)))}`);
  }

  console.log("\n=== hour bucket × side (the session's losers were globex shorts) ===");
  for (const b of buckets) {
    const l = all.filter((t) => t.bucket === b && t.dir === "long");
    const s = all.filter((t) => t.bucket === b && t.dir === "short");
    if (!l.length && !s.length) continue;
    console.log(`  ${b}:`);
    console.log(`    ${fmtRow("long", stats(l))}`);
    console.log(`    ${fmtRow("short", stats(s))}`);
  }

  console.log("\n=== context slice: counter-trend entries (delta sign vs dir) ===");
  console.log("  (deltaFrac is the expansion bar's one-sided share; dir is the trade)");
  const withTape = all.filter((t) => t.deltaFrac >= 0.75);
  console.log(`  ${fmtRow("≥75% one-sided", stats(withTape))}`);
  const under = all.filter((t) => t.deltaFrac < 0.75 && t.deltaFrac > 0);
  console.log(`  ${fmtRow("<75% one-sided", stats(under))}`);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * primary cohort = ALL expansion trades; T1 all/train/test (split 2026-01-01),
   * T2 hour-bucket × side cells, T4 prop viability, five-slot verdict. ---- */
  const engineTrades = all.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const allStats = coreStats(engineTrades);
  const trainStats = coreStats(engineTrades.filter((t) => t.date < SPLIT));
  const testStats = coreStats(engineTrades.filter((t) => t.date >= SPLIT));
  console.log("\n=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "all", stats: allStats },
      { label: "train", stats: trainStats },
      { label: "test", stats: testStats },
    ]),
  );
  const cellRows: { rule: string; rows: T[] }[] = [];
  for (const b of buckets) {
    const l = all.filter((t) => t.bucket === b && t.dir === "long");
    const s = all.filter((t) => t.bucket === b && t.dir === "short");
    if (l.length) cellRows.push({ rule: `${b} long`, rows: l });
    if (s.length) cellRows.push({ rule: `${b} short`, rows: s });
  }
  const engineOf = (rows: T[]) => rows.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  console.log(
    "\n" +
      renderT2(
        cellRows.map(({ rule, rows }) => {
          const st = coreStats(engineOf(rows));
          const tr = coreStats(engineOf(rows).filter((t) => t.date < SPLIT));
          const te = coreStats(engineOf(rows).filter((t) => t.date >= SPLIT));
          const opp = cellRows.find((c) => c.rule === rule.replace(/ (long|short)$/, (m) => (m === " long" ? " short" : " long")));
          const oppSt = opp ? coreStats(engineOf(opp.rows)) : null;
          return {
            rule,
            n: st.n,
            wr: st.wr,
            ci: wilson95(st.wins, st.n),
            pf: st.pf,
            expPts: st.expPts,
            trainTest: `${tr.wr.toFixed(0)}% / ${te.wr.toFixed(0)}%`,
            compare: oppSt ? `opposite side WR ${oppSt.wr.toFixed(0)}%` : undefined,
          };
        }),
      ),
  );
  const viability = propViability(engineTrades, { splitDate: SPLIT });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: testStats.netPts > 0 && testStats.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(trainStats.wr - testStats.wr).toFixed(1)} pts`,
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
