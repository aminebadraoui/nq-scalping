/* ------------------------------------------------------------------ *
 * Sweep-reclaim v2 study — does Pulcini's ATR-push proof resurrect the
 * retired sweep-reclaim fade?
 *
 * Variants swept over the R2 archive (lookahead-free, sequential
 * one-trade-at-a-time, pessimistic same-bar stop-first, 0.5 pt
 * round-trip cost, 60-bar time exit, train/test split 2026-01-01):
 *
 *   atrMult        {0 (v1: reclaim entry, no proof), 0.5, 0.75, 1.0, 1.15}
 *   anchor         {local(20), session}
 *   reclaimOneSided{0, 0.65}   — require the reclaim bar itself one-sided
 *   hourFilter     {globex, none}
 *   targetR        {1.0, 1.5}
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/sweepReclaimV2Study.ts [--max N] [--split 2026-01-01] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectSweepReclaimV2,
  type SweepReclaimV2Config,
  type SweepReclaimV2Signal,
} from "../lib/sweepReclaimV2";
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

function scoreTrade(minutes: MomMinute[], sig: SweepReclaimV2Signal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0)) return null;
  const start = sig.confirmIdx + 1;
  const end = Math.min(minutes.length - 1, sig.confirmIdx + HOLD_BARS);
  if (start > end) return null;

  let hit: Scored["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.confirmIdx;

  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - sig.confirmIdx;
      break;
    }
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - sig.confirmIdx;
      break;
    }
  }

  const pnl = (exit - entry) * dir - COST_PTS;
  return { date, hourET: sig.hourET, dir: sig.dir, entry, stop, risk, pnl, hit, heldBars };
}

/** one trade at a time — the live trader cannot be in two positions */
function replay(minutes: MomMinute[], sigs: SweepReclaimV2Signal[], date: string): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.confirmIdx <= openUntil) continue;
    const sc = scoreTrade(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.confirmIdx + sc.heldBars;
  }
  return out;
}

function stats(tt: Scored[]) {
  const n = tt.length;
  const wins = tt.filter((t) => t.pnl > 0).length;
  const gw = tt.reduce((a, t) => a + Math.max(0, t.pnl), 0);
  const gl = tt.reduce((a, t) => a + Math.max(0, -t.pnl), 0);
  const expR = n ? tt.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0;
  return {
    n,
    wr: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net: gw - gl,
    expR,
  };
}

function fmt(s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}%  pf=${pf.padStart(5)}  net=${s.net.toFixed(0).padStart(8)}  expR=${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(3)}`;
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

type Variant = { label: string; cfg: SweepReclaimV2Config };

function variants(): Variant[] {
  const base: SweepReclaimV2Config = {
    anchor: "local",
    sweepBars: 20,
    sweepTolPts: 0.25,
    reclaimWindow: 2,
    reclaimOneSided: 0,
    confirmWindow: 10,
    atrMult: 1.0,
    atrBars: 14,
    atrPad: 1.15,
    stopPad: 0.5,
    targetR: 1,
    maxRiskPts: 40,
    minRiskPts: 1.5,
    minGapBars: 5,
    hourFilter: "globex",
  };
  const out: Variant[] = [];
  const atrMults: { m: number; label: string }[] = [
    { m: 0, label: "v1 (reclaim entry)" },
    { m: 0.5, label: "0.5×ATR" },
    { m: 0.75, label: "0.75×ATR" },
    { m: 1.0, label: "1.0×ATR" },
    { m: 1.15, label: "1.15×ATR" },
  ];
  for (const am of atrMults) {
    for (const anchor of ["local", "session"] as const) {
      for (const r1s of [0, 0.65]) {
        for (const hf of ["globex", "none"] as const) {
          for (const targetR of [1, 1.5]) {
            out.push({
              label: `${am.label} | ${anchor} | 1s${r1s} | ${hf} | ${targetR}R`,
              cfg: { ...base, atrMult: am.m, anchor, reclaimOneSided: r1s, hourFilter: hf, targetR },
            });
          }
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
      for (let p = 0; p < vars.length; p++) {
        results[p].trades.push(...replay(minutes, detectSweepReclaimV2(minutes, vars[p].cfg), date));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  // sort variants by test-period expR for the summary table
  const rows = results.map((r, idx) => {
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
    return { idx, label: r.label, all, sAll, sTest, d, evAll, evTest, worst, dollarNet: d.reduce((a, t) => a + t.pnl, 0) };
  });
  rows.sort((a, b) => b.sTest.expR - a.sTest.expR);

  console.log("SWEEP-RECLAIM v2 — full archive (all) vs test ≥ " + splitDate + ", sorted by test expR:");
  for (const r of rows) {
    const s = r.sAll;
    const st = r.sTest;
    console.log(
      `${r.label.padEnd(38)} | ${fmt(s)} | test: n=${String(st.n).padStart(4)} wr=${st.wr.toFixed(1).padStart(5)}% pf=${Number.isFinite(st.pf) ? st.pf.toFixed(2).padStart(5) : "  inf"} expR=${st.expR >= 0 ? "+" : ""}${st.expR.toFixed(3)} | $${r.dollarNet.toFixed(0).padStart(7)} worst $${r.worst.toFixed(0).padStart(5)} | eval ${accountLine(r.evAll)} | test ${accountLine(r.evTest)}`,
    );
  }

  console.log("\nBY DIRECTION (best 4 variants by test expR):");
  for (const r of rows.slice(0, 4)) {
    for (const dir of ["long", "short"] as const) {
      const tt = r.all.filter((t) => t.dir === dir);
      console.log(`  ${r.label.padEnd(38)} | ${dir.padEnd(5)} | ${fmt(stats(tt))}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
