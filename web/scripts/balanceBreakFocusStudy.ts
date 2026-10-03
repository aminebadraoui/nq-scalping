/* ------------------------------------------------------------------ *
 * Balance-break FOCUS study — follow-up on the main sweep.
 *
 * The full sweep showed the fade edge concentrates in SHORTS (failed UP
 * breakouts: PF 1.93–2.28 vs longs 1.23–1.28) and in two configs:
 *   A: bal60 | failMode mid | 1s0.65 | 1R      (n=357, expR +0.140)
 *   B: bal30 | failMode mid | 1s0.55 | edge    (n=3377, 71.3% WR)
 *
 * This run measures direction × targetR around those two:
 *   A: both | long-only | short-only  ×  {1R, 1.5R}
 *   B: both | long-only | short-only  ×  {edge, 1R}
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/balanceBreakFocusStudy.ts [--max N] [--split 2026-01-01] [--offline]
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
  return { date, dir: sig.dir, entry, stop, risk, pnl: (exit - entry) * dir - COST_PTS, hit, heldBars };
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

const BASE: BalanceBreakConfig = {
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

type Variant = { label: string; cfg: BalanceBreakConfig; dirFilter: "both" | "long" | "short" };

function variants(): Variant[] {
  const out: Variant[] = [];
  const A: BalanceBreakConfig = { ...BASE, balBars: 60, failMode: "mid", failOneSided: 0.65, targetMode: "1R" };
  const B: BalanceBreakConfig = { ...BASE, balBars: 30, failMode: "mid", failOneSided: 0.55, targetMode: "edge" };
  for (const dir of ["both", "long", "short"] as const) {
    out.push({ label: `A bal60|mid|0.65 ${dir} 1R`, cfg: A, dirFilter: dir });
    out.push({ label: `A bal60|mid|0.65 ${dir} 1.5R`, cfg: { ...A, targetR: 1.5 }, dirFilter: dir });
    out.push({ label: `B bal30|mid|0.55 ${dir} edge`, cfg: B, dirFilter: dir });
    out.push({ label: `B bal30|mid|0.55 ${dir} 1R`, cfg: { ...B, targetMode: "1R" }, dirFilter: dir });
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
  console.log(`replaying ${dates.length} sessions × ${vars.length} variants`);

  const results = vars.map((v) => ({ label: v.label, trades: [] as Scored[] }));

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
      const bal30 = precomputeBalances(minutes, 30);
      const bal60 = precomputeBalances(minutes, 60);
      for (let p = 0; p < vars.length; p++) {
        const cfg = vars[p].cfg;
        const bal = cfg.balBars === 30 ? bal30 : bal60;
        let sigs = detectBalanceBreakPre(minutes, bal, cfg);
        if (vars[p].dirFilter !== "both") sigs = sigs.filter((s) => s.dir === vars[p].dirFilter);
        results[p].trades.push(...replay(minutes, sigs, date));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  console.log(`BALANCE-BREAK FOCUS (test ≥ ${splitDate}):`);
  for (const r of results) {
    const all = r.trades;
    const test = all.filter((t) => t.date >= splitDate);
    const s = stats(all);
    const st = stats(test);
    const d = dollarize(all.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const evAll = simulateAccount(d, "eval");
    const worst = evAll.days.reduce((a, x) => Math.min(a, x.pnl), 0);
    console.log(
      `${r.label.padEnd(30)} | ${fmt(s)} | test: n=${String(st.n).padStart(4)} wr=${st.wr.toFixed(1).padStart(5)}% pf=${Number.isFinite(st.pf) ? st.pf.toFixed(2).padStart(5) : "  inf"} expR=${st.expR >= 0 ? "+" : ""}${st.expR.toFixed(3)} | $${d.reduce((a, t) => a + t.pnl, 0).toFixed(0).padStart(7)} worst $${worst.toFixed(0).padStart(5)} | eval ${accountLine(evAll)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
