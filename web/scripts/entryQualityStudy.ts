/* ------------------------------------------------------------------ *
 * Entry-quality study — replay the 2026-10-02 AI review's ONE next
 * experiment over the R2 archive, scored against ITS success criteria.
 *
 * Modeling honesty (differences from riskStackStudy.ts):
 *   · fills happen at the NEXT bar's open (live market order; the
 *     signal bar's close is fiction — "the signal price is fiction").
 *     `live(ref)` = the riskStackStudy close-fill model, for reference.
 *   · brackets are anchored at the FILL: stop = fill ∓ risk, ladder
 *     rungs from the fill — exactly what the live REST brackets do.
 *   · drift = (fill − signal close) × dir; adverse drift is negative.
 *
 * Levers under test (the AI review's proposal, one per family):
 *   drift1.5 / drift2.0      skip entries whose fill lands >1.5 / >2 pts
 *                            adverse of the signal close (all families)
 *   drift1.5 shorts+exp      the AI's default scope: shorts + expansion
 *   atrStop rth              rth stop relocated below the bar extreme by
 *                            max(1pt, k×ATR14) instead of the 1-pt pad
 *   exp retrace              expansion: no market fill — wait up to 5
 *                            bars for a 1-pt retrace (limit), else skip
 *   combined                 shorts+exp drift gate + 0.75×ATR rth stop
 *                            + expansion retrace entries
 *
 * AI success criteria (from the review): stop-run rate < 50%,
 * net expectancy > 0, win count reduced by < ~20%.
 * Stop-run replay proxy: stop-out where price returns beyond the fill
 * within 10 bars — the live "recovered" tag.
 *
 * Run from web/:
 *   node --import scripts/ts-loader.mjs scripts/entryQualityStudy.ts --offline
 * ------------------------------------------------------------------ */

import { marketFillEstimate, DEFAULT_SLIP_PTS, TICK } from "../lib/honestFill";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { simulateAccount, accountLine } from "../lib/propAccount";
import { scoreScaleOut } from "../lib/runner";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  midOf,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import { coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";

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

type FamTag = "momentum" | "expansion" | "rth" | "open";
type Signal = { s: MomentumSignal; fam: FamTag };

function detectAll(minutes: MomMinute[]): Signal[] {
  const out: Signal[] = [];
  for (const s of detectMomentum(minutes, MOM_PROD)) out.push({ s, fam: "momentum" });
  for (const s of detectExpansionScalp(minutes, EXP_PROD)) out.push({ s, fam: "expansion" });
  for (const s of detectSoftMomentum(minutes, SOFT_PROD)) out.push({ s, fam: "rth" });
  for (const s of detectOpenDrive(minutes, OPEN_PROD)) out.push({ s, fam: "open" });
  return out.sort((a, b) => a.s.entryIdx - b.s.entryIdx);
}

type Variant = {
  name: string;
  closeFill: boolean;
  drift: { maxAdverse: number; scope: "all" | "shortExp" } | null;
  rthAtrPad: number; // 0 = live 1.0-pt pad below the bar extreme
  expRetrace: boolean;
};

const VARIANTS: Variant[] = [
  { name: "live(ref)", closeFill: true, drift: null, rthAtrPad: 0, expRetrace: false },
  { name: "open-fill", closeFill: false, drift: null, rthAtrPad: 0, expRetrace: false },
  { name: "drift1.5", closeFill: false, drift: { maxAdverse: 1.5, scope: "all" }, rthAtrPad: 0, expRetrace: false },
  { name: "drift2.0", closeFill: false, drift: { maxAdverse: 2.0, scope: "all" }, rthAtrPad: 0, expRetrace: false },
  { name: "drift1.5 sh+exp", closeFill: false, drift: { maxAdverse: 1.5, scope: "shortExp" }, rthAtrPad: 0, expRetrace: false },
  { name: "rth atr0.5", closeFill: false, drift: null, rthAtrPad: 0.5, expRetrace: false },
  { name: "rth atr0.75", closeFill: false, drift: null, rthAtrPad: 0.75, expRetrace: false },
  { name: "exp retrace", closeFill: false, drift: null, rthAtrPad: 0, expRetrace: true },
  { name: "combined", closeFill: false, drift: { maxAdverse: 1.5, scope: "shortExp" }, rthAtrPad: 0.75, expRetrace: true },
];

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

const sizeOf = (fam: FamTag, riskPts: number): number => {
  if (fam === "momentum" || fam === "expansion") {
    return Math.max(1, Math.min(30, Math.floor(170 / (riskPts * 2))));
  }
  return Math.max(1, Math.min(9, Math.floor(200 / (riskPts * 2))));
};

const tierOf = (dayPnl: number): number => {
  for (const t of TIERS) if (dayPnl >= t.threshold) return t.multiplier;
  return 1;
};

type Trade = {
  date: string;
  fam: FamTag;
  dir: 1 | -1;
  pnlPts: number;
  riskPts: number;
  contracts: number;
  pnlUsd: number;
  hit: "stop" | "time";
  drift: number;
  recovered: boolean;
};

function runVariant(v: Variant, date: string, minutes: MomMinute[], signals: Signal[]): { trades: Trade[]; rejected: number } {
  const trades: Trade[] = [];
  let rejected = 0;
  let dayPnl = 0;
  let dayPeak = 0;
  let halt = false;
  let openUntil = -1;
  for (const { s, fam } of signals) {
    const dir = s.dir === "long" ? 1 : -1;

    /* 1) resolve the fill */
    let fill: number;
    let fillIdx: number;
    if (v.closeFill) {
      fill = s.entry;
      fillIdx = s.entryIdx;
    } else {
      if (s.entryIdx + 1 >= minutes.length) {
        rejected++;
        continue;
      }
      // honest market fill: the true open when joined, else the unbiased
      // next-open estimate from the signal bar, plus slippage
      fill = (minutes[s.entryIdx + 1].o > 0 ? minutes[s.entryIdx + 1].o : marketFillEstimate(minutes[s.entryIdx], dir)) + dir * DEFAULT_SLIP_PTS;
      fillIdx = s.entryIdx + 1;
    }
    if (v.expRetrace && fam === "expansion") {
      const level = s.entry - dir * RETRACE_PTS;
      let touched = -1;
      for (let j = s.entryIdx + 1; j <= Math.min(minutes.length - 1, s.entryIdx + RETRACE_BARS); j++) {
        const b = minutes[j];
        // honest: a one-tick trade-through (touch ≠ fill)
        if (dir > 0 ? b.low <= level - TICK : b.high >= level + TICK) {
          touched = j;
          break;
        }
      }
      if (touched < 0) {
        rejected++;
        continue;
      }
      const b = minutes[touched];
      fill = (b.o ?? 0) > 0 ? (dir > 0 ? Math.min(b.o, level) : Math.max(b.o, level)) : level;
      fillIdx = touched;
    }
    const drift = (fill - s.entry) * dir;

    /* 2) flat rule (one MNQ position at a time) */
    if (fillIdx <= openUntil) continue;

    /* 3) entry-location gate: reject adverse fill drift */
    if (v.drift && drift < -v.drift.maxAdverse) {
      const scoped = v.drift.scope === "all" || s.dir === "short" || fam === "expansion";
      if (scoped) {
        rejected++;
        continue;
      }
    }

    /* 4) risk anchor (brackets built from the fill) */
    let risk: number;
    if (fam === "rth" && v.rthAtrPad > 0) {
      const bar = minutes[s.entryIdx];
      const pad = Math.max(1.0, v.rthAtrPad * s.atr14);
      const stopAnchor = dir > 0 ? bar.low - pad : bar.high + pad;
      risk = Math.abs(fill - stopAnchor);
      if (!(risk > 0) || risk > 15) {
        rejected++;
        continue;
      }
    } else {
      risk = Math.abs(s.entry - s.stop);
      if (!(risk > 0)) continue;
    }
    const stop = fill - dir * risk;

    /* 5) score the ladder exit from the fill bar */
    const mb = fam === "rth" ? Math.min(60, Math.max(1, minutes.findIndex((m) => m.t === "15:00") - s.entryIdx)) : 60;
    if (mb < 1) continue;
    // the close-fill reference is the LEGACY unreachable idealization (kept
    // to show the gap); every other variant scores its real fill honestly
    const t = v.closeFill
      ? scoreScaleOut(minutes, fill, stop, dir, fillIdx, { maxBars: mb, cost: COST, fill: "legacy" })
      : scoreScaleOut(minutes, fill, stop, dir, fillIdx - 1, { maxBars: mb, cost: COST, entryKind: "fixed", commissionInUsd: true });
    if (!t) continue;
    if (halt) continue; // give-back halt: skip remaining entries today

    /* 6) dollars: live sizing + tiers + commissions */
    let contracts = sizeOf(fam, risk);
    const mult = tierOf(dayPnl);
    if (mult < 1) contracts = Math.max(1, Math.round(contracts * mult));
    const pnlUsd = t.pnl * contracts * 2 - 2 * contracts * COMM_PER_SIDE;

    /* 7) stop-run proxy: stopped, then price returned beyond the fill */
    const exitBar = fillIdx - 1 + t.heldBars;
    let recovered = false;
    if (t.hit === "stop") {
      for (let j = exitBar + 1; j <= Math.min(minutes.length - 1, exitBar + RECOVER_BARS); j++) {
        if (dir > 0 ? minutes[j].high >= fill : minutes[j].low <= fill) {
          recovered = true;
          break;
        }
      }
    }

    trades.push({ date, fam, dir, pnlPts: t.pnl, riskPts: risk, contracts, pnlUsd, hit: t.hit, drift, recovered });
    dayPnl += pnlUsd;
    dayPeak = Math.max(dayPeak, dayPnl);
    openUntil = exitBar;
    if (dayPeak > GIVEBACK.floor) {
      const limit = Math.max(GIVEBACK.floor, GIVEBACK.pct * dayPeak);
      if (dayPnl <= dayPeak - limit) halt = true;
    }
  }
  return { trades, rejected };
}

/* ---------------- aggregation ---------------- */

type Summary = {
  n: number;
  wins: number;
  losses: number;
  scratch: number;
  wr: number; // over decided trades (W / W+L), like the live journal
  net: number;
  pf: number;
  expUsd: number;
  commissions: number;
  stopLosses: number;
  recovered: number;
  stopRunOfLosses: number; // %
  stopRunOfTrades: number; // %
  avgAdvDrift: number; // mean |drift| over adverse fills
  advGt15: number; // fills worse than 1.5 pts
  worstDay: number;
  medianDay: number;
  breaches: number;
};

function summarize(trades: Trade[]): Summary {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const scratch = n - wins.length - losses.length;
  const gw = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));
  const net = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const comm = trades.reduce((a, t) => a + 2 * t.contracts * COMM_PER_SIDE, 0);
  const stopLosses = trades.filter((t) => t.hit === "stop" && t.pnlUsd < 0);
  const recovered = stopLosses.filter((t) => t.recovered);
  const adv = trades.filter((t) => t.drift < 0).map((t) => -t.drift);
  const byDay = new Map<string, number>();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnlUsd);
  const days = [...byDay.values()].sort((a, b) => a - b);
  const decided = wins.length + losses.length;
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    scratch,
    wr: decided ? (wins.length / decided) * 100 : 0,
    net,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    expUsd: n ? net / n : 0,
    commissions: comm,
    stopLosses: stopLosses.length,
    recovered: recovered.length,
    stopRunOfLosses: stopLosses.length ? (recovered.length / stopLosses.length) * 100 : 0,
    stopRunOfTrades: n ? (recovered.length / n) * 100 : 0,
    avgAdvDrift: adv.length ? adv.reduce((a, b) => a + b, 0) / adv.length : 0,
    advGt15: adv.filter((d) => d > 1.5).length,
    worstDay: days[0] ?? 0,
    medianDay: days.length ? days[Math.floor(days.length / 2)] : 0,
    breaches: days.filter((d) => d > 900).length,
  };
}

const fmtUsd = (v: number): string => (v >= 0 ? "+$" : "−$") + Math.abs(Math.round(v)).toLocaleString("en-US");

function row(name: string, s: Summary, rejected: number, keptPct: string): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return (
    `${name.padEnd(16)} ${String(s.n).padStart(5)} ${String(s.wins).padStart(4)}W ${String(s.losses).padStart(4)}L ` +
    `${s.wr.toFixed(1).padStart(5)}% ${fmtUsd(s.net).padStart(10)} ${`pf ${pf}`.padStart(8)} ` +
    `${fmtUsd(s.expUsd).padStart(8)}/tr ${`sr ${s.stopRunOfLosses.toFixed(0)}%`.padStart(8)} ` +
    `${`adv ${s.avgAdvDrift.toFixed(1)}`.padStart(8)} ${`rej ${rejected}`.padStart(7)} ${keptPct.padEnd(8)}`
  );
}

/* ---------------- main ---------------- */

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
  console.log(`entry-quality study · ${dates.length} sessions · split ${split}\n`);
  console.log("model: next-bar-open fills, brackets anchored at fill, ladder exits, live sizing/tiers/give-back");
  console.log("stop-run proxy: stop-out where price returns beyond the fill within 10 bars\n");

  const accum = VARIANTS.map((v) => ({ v, trades: [] as Trade[], rejected: 0 }));
  const t0 = Date.now();
  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals = detectAll(minutes);
      if (!signals.length) continue;
      for (const a of accum) {
        const r = runVariant(a.v, date, minutes, signals);
        a.trades.push(...r.trades);
        a.rejected += r.rejected;
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const sums = accum.map((a) => ({ ...a, s: summarize(a.trades) }));
  const base = sums.find((x) => x.v.name === "open-fill")!;

  console.log("variant          |    n  W/L    WR%      net      pf   $/trade  stopRun  advDrift  rej   kept");
  console.log("-------------------------------------------------------------------------------------------------");
  for (const a of sums) {
    const kept = a.v.name === "open-fill" ? "—" : `${((a.trades.length / base.trades.length) * 100).toFixed(0)}%`;
    console.log(row(a.v.name, a.s, a.rejected, kept));
  }
  console.log("\nkept = trades kept vs open-fill baseline (AI criterion: ≥ ~80%)");

  console.log("\nTRAIN (< split) / TEST (≥ split):");
  for (const a of sums) {
    const tr = summarize(a.trades.filter((t) => t.date < split));
    const te = summarize(a.trades.filter((t) => t.date >= split));
    console.log(
      `${a.v.name.padEnd(16)} | TRAIN n=${String(tr.n).padStart(5)} wr=${tr.wr.toFixed(1).padStart(5)}% net=${fmtUsd(tr.net).padStart(10)} sr=${tr.stopRunOfLosses.toFixed(0).padStart(3)}%` +
        `  |  TEST n=${String(te.n).padStart(5)} wr=${te.wr.toFixed(1).padStart(5)}% net=${fmtUsd(te.net).padStart(10)} sr=${te.stopRunOfLosses.toFixed(0).padStart(3)}%`,
    );
  }

  console.log("\nAI success criteria (vs open-fill): stop-run < 50% of losses · expectancy > 0 · wins kept ≥ 80%");
  console.log("variant          |  Δnet vs base   stopRun(loss)  exp $/trade  wins kept   VERDICT");
  console.log("----------------------------------------------------------------------------------------");
  for (const a of sums) {
    if (a.v.name === "live(ref)" || a.v.name === "open-fill") continue;
    const dNet = a.s.net - base.s.net;
    const winsKept = ((a.s.wins / base.s.wins) * 100).toFixed(0) + "%";
    const ok1 = a.s.stopRunOfLosses < 50;
    const ok2 = a.s.expUsd > 0;
    const ok3 = a.s.wins / base.s.wins >= 0.8;
    const verdict = ok1 && ok2 && ok3 ? "PASS ✓" : `${ok1 ? "✓" : "✗"} ${ok2 ? "✓" : "✗"} ${ok3 ? "✓" : "✗"} FAIL`;
    console.log(
      `${a.v.name.padEnd(16)} ${fmtUsd(dNet).padStart(13)}  ${String(a.s.stopRunOfLosses.toFixed(0) + "%").padStart(14)}  ${fmtUsd(a.s.expUsd).padStart(11)}  ${winsKept.padStart(9)}   ${verdict}`,
    );
  }

  console.log("\nACCOUNT (Rapid EOD 50k):");
  for (const a of sums) {
    const trades = a.trades.map((t) => ({ date: t.date, pnl: t.pnlUsd }));
    const evalSim = simulateAccount(trades, "eval");
    const funded = simulateAccount(trades, "funded");
    console.log(
      `${a.v.name.padEnd(16)} worst ${fmtUsd(a.s.worstDay).padStart(9)} med ${fmtUsd(a.s.medianDay).padStart(9)} breaches ${String(a.s.breaches).padStart(3)} | eval: ${accountLine(evalSim)} | funded: ${accountLine(funded)}`,
    );
  }

  const fams: FamTag[] = ["momentum", "expansion", "rth", "open"];
  const byFam = (trades: Trade[], fam: FamTag): Trade[] => trades.filter((t) => t.fam === fam);
  console.log("\nper-family: open-fill vs combined");
  console.log("family       |             open-fill                    |              combined");
  console.log("             |    n   W/L  WR%     net   PF  srLoss adv |    n   W/L  WR%     net   PF  srLoss adv");
  console.log("-----------------------------------------------------------------------------------------------");
  for (const fam of fams) {
    const bf = summarize(byFam(base.trades, fam));
    const cf = summarize(byFam(sums.find((x) => x.v.name === "combined")!.trades, fam));
    const pf = (s: Summary): string => (Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf");
    console.log(
      `${fam.padEnd(12)} | ${String(bf.n).padStart(4)} ${String(bf.wins).padStart(3)}/${String(bf.losses).padStart(2)} ${bf.wr.toFixed(0).padStart(3)}% ${fmtUsd(bf.net).padStart(9)} ${pf(bf).padStart(5)} ${String(bf.stopRunOfLosses.toFixed(0) + "%").padStart(6)} ${bf.avgAdvDrift.toFixed(1).padStart(4)}` +
        ` | ${String(cf.n).padStart(4)} ${String(cf.wins).padStart(3)}/${String(cf.losses).padStart(2)} ${cf.wr.toFixed(0).padStart(3)}% ${fmtUsd(cf.net).padStart(9)} ${pf(cf).padStart(5)} ${String(cf.stopRunOfLosses.toFixed(0) + "%").padStart(6)} ${cf.avgAdvDrift.toFixed(1).padStart(4)}`,
    );
  }

  const flushLate = base.trades.filter((t) => t.fam === "momentum" && t.drift < -2);
  const flushLateNet = flushLate.reduce((a, t) => a + t.pnlUsd, 0);
  console.log(`\nfailed_flush_breakout late chases (open-fill drift < −2 pts): n=${flushLate.length} net=${fmtUsd(flushLateNet)}`);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Engine-level stats on point-level P&L (pnlPts/riskPts — the legacy
   * USD summarize above stays untouched: its WR is decided-only W/(W+L)
   * and its PF excludes scratch trades, both intentionally different
   * from the engine's wins = pnl>0 over all n). Primary cohort = the
   * open-fill baseline. ---- */
  const splitDate = split;
  const engineTrades = base.trades.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const eAll = coreStats(engineTrades);
  const eTrain = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const eTest = coreStats(engineTrades.filter((t) => t.date >= splitDate));
  console.log("\n=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "all", stats: eAll },
      { label: "train", stats: eTrain },
      { label: "test", stats: eTest },
    ]),
  );
  const vStats = sums.map((a) => {
    const toEngine = (ts: Trade[]) => ts.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
    const s = coreStats(toEngine(a.trades));
    const sTr = coreStats(toEngine(a.trades.filter((t) => t.date < splitDate)));
    const sTe = coreStats(toEngine(a.trades.filter((t) => t.date >= splitDate)));
    return { name: a.v.name, s, sTr, sTe };
  });
  const wrOf = (name: string): string => `${vStats.find((x) => x.name === name)!.s.wr.toFixed(0)}% WR`;
  console.log(
    "\n" +
      renderT2(
        vStats.map((v) => ({
          rule: v.name,
          n: v.s.n,
          wr: v.s.wr,
          ci: wilson95(v.s.wins, v.s.n),
          pf: v.s.pf,
          expPts: v.s.expPts,
          trainTest: `${v.sTr.wr.toFixed(0)}% / ${v.sTe.wr.toFixed(0)}%`,
          compare: v.name === "live(ref)" ? "—" : v.name === "open-fill" ? `live(ref) ${wrOf("live(ref)")}` : `open-fill ${wrOf("open-fill")}`,
        })),
      ),
  );
  const viability = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: eTest.netPts > 0 && eTest.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(eTrain.wr - eTest.wr).toFixed(1)} pts`,
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
