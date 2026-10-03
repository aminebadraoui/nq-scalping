/* ------------------------------------------------------------------ *
 * Failed-balance-breakout study — Pulcini's "best position trade":
 * breakout beyond a balance edge, failure back through the balance's
 * POC, fade the trapped side.
 *
 * Variants swept over the R2 archive (lookahead-free, sequential
 * one-trade-at-a-time, pessimistic same-bar stop-first, 0.5 pt
 * round-trip cost, 60-bar time exit, train/test split 2026-01-01):
 *
 *   balBars      {30, 60, 120}        — the balance window
 *   failMode     {inside, mid, poc}   — where the failure is proven
 *   failOneSided {0, 0.55, 0.65}      — puke proof on the failure bar
 *   targetMode   {1R, edge}           — 1R vs the opposite balance edge
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/balanceBreakStudy.ts [--max N] [--split 2026-01-01] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectBalanceBreakPre,
  precomputeBalances,
  type BalanceBreakConfig,
  type BalanceBreakSignal,
  type Balance,
} from "../lib/balanceBreak";
import { closeOf, type MomMinute } from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;

type Scored = {
  date: string;
  hourET: number;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
};

function scoreTrade(minutes: MomMinute[], sig: BalanceBreakSignal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0)) return null;
  const start = sig.failIdx + 1;
  const end = Math.min(minutes.length - 1, sig.failIdx + HOLD_BARS);
  if (start > end) return null;

  let hit: Scored["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.failIdx;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - sig.failIdx;
      break;
    }
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - sig.failIdx;
      break;
    }
  }

  const pnl = (exit - entry) * dir - COST_PTS;
  return { date, hourET: sig.hourET, dir: sig.dir, entry, stop, risk, pnl, hit, heldBars };
}

function replay(minutes: MomMinute[], sigs: BalanceBreakSignal[], date: string): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.failIdx <= openUntil) continue;
    const sc = scoreTrade(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.failIdx + sc.heldBars;
  }
  return out;
}

function stats(tt: Scored[]) {
  const n = tt.length;
  const wins = tt.filter((t) => t.pnl > 0).length;
  const gw = tt.reduce((a, t) => a + Math.max(0, t.pnl), 0);
  const gl = tt.reduce((a, t) => a + Math.max(0, -t.pnl), 0);
  const expR = n ? tt.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0;
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, net: gw - gl, expR };
}

function fmt(s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}%  pf=${pf.padStart(5)}  net=${s.net.toFixed(0).padStart(8)}  expR=${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(3)}`;
}

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

type Variant = { label: string; cfg: BalanceBreakConfig };

function variants(): Variant[] {
  const base: BalanceBreakConfig = {
    balBars: 60,
    breakTolPts: 0.25,
    failWindow: 10,
    failMode: "poc",
    failOneSided: 0,
    stopPad: 0.5,
    targetMode: "1R",
    targetR: 1,
    maxRiskPts: 40,
    minRiskPts: 2,
    minGapBars: 5,
    hourFilter: "none",
  };
  const out: Variant[] = [];
  for (const balBars of [30, 60, 120]) {
    for (const failMode of ["inside", "mid", "poc"] as const) {
      for (const failOneSided of [0, 0.55, 0.65]) {
        for (const targetMode of ["1R", "edge"] as const) {
          out.push({
            label: `bal${balBars} | ${failMode} | 1s${failOneSided} | ${targetMode}`,
            cfg: { ...base, balBars, failMode, failOneSided, targetMode },
          });
        }
      }
    }
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const splitDate = o.split ?? "2026-01-01";
  const vars = variants();

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(
    `replaying ${dates.length} sessions × ${vars.length} variants (sequential, first-touch, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit)`,
  );

  const results = vars.map((v) => ({ label: v.label, balBars: v.cfg.balBars, trades: [] as Scored[] }));
  const WINDOWS = [30, 60, 120];

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
      // one balance pass per window size, shared by every variant
      const balCache = new Map<number, (Balance | null)[]>();
      for (const w of WINDOWS) balCache.set(w, precomputeBalances(minutes, w));
      for (let p = 0; p < vars.length; p++) {
        results[p].trades.push(
          ...replay(minutes, detectBalanceBreakPre(minutes, balCache.get(vars[p].cfg.balBars)!, vars[p].cfg), date),
        );
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  const rows = results.map((r) => {
    const all = r.trades;
    const test = all.filter((t) => t.date >= splitDate);
    const sAll = stats(all);
    const sTest = stats(test);
    const d = dollarize(all.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const evAll = simulateAccount(d, "eval");
    const evTest = simulateAccount(
      dollarize(test.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk }))),
      "eval",
    );
    const worst = evAll.days.reduce((a, x) => Math.min(a, x.pnl), 0);
    return { label: r.label, all, sAll, sTest, evAll, evTest, worst, dollarNet: d.reduce((a, t) => a + t.pnl, 0) };
  });
  rows.sort((a, b) => b.sTest.expR - a.sTest.expR);

  console.log("FAILED BALANCE BREAKOUT — full archive (all) vs test ≥ " + splitDate + ", sorted by test expR:");
  for (const r of rows) {
    const s = r.sAll;
    const st = r.sTest;
    console.log(
      `${r.label.padEnd(26)} | ${fmt(s)} | test: n=${String(st.n).padStart(4)} wr=${st.wr.toFixed(1).padStart(5)}% pf=${Number.isFinite(st.pf) ? st.pf.toFixed(2).padStart(5) : "  inf"} expR=${st.expR >= 0 ? "+" : ""}${st.expR.toFixed(3)} | $${r.dollarNet.toFixed(0).padStart(7)} worst $${r.worst.toFixed(0).padStart(5)} | eval ${accountLine(r.evAll)} | test ${accountLine(r.evTest)}`,
    );
  }

  console.log("\nBY DIRECTION (best 4 variants by test expR):");
  for (const r of rows.slice(0, 4)) {
    for (const dir of ["long", "short"] as const) {
      const tt = r.all.filter((t) => t.dir === dir);
      console.log(`  ${r.label.padEnd(26)} | ${dir.padEnd(5)} | ${fmt(stats(tt))}`);
    }
    console.log();
  }

  // hour-of-day anatomy for the overall best (by test expR)
  const best = rows[0];
  console.log(`HOURS OF DAY — ${best.label} (all trades):`);
  const byHour = new Map<number, Scored[]>();
  for (const t of best.all) {
    const a = byHour.get(t.hourET);
    if (a) a.push(t);
    else byHour.set(t.hourET, [t]);
  }
  for (const [h, tt] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    ${String(h).padStart(2)}:00  ${fmt(stats(tt))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
