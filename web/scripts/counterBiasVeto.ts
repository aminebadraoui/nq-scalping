/* ------------------------------------------------------------------ *
 * Counter-bias veto study — the targeted replacement for the global
 * day-bias filter (rthDayBias.ts measured the global filter at
 * +0.16 pts/trade while discarding 62% of trades).
 *
 * Day bias = cumulative buy−sell of the 9:30–10:00 ET window (same
 * definition as rthDayBias). Veto: when |bias| ≥ T, skip trades
 * AGAINST the bias (shorts on strongly bullish opens, longs on strongly
 * bearish). Neutral-bias days and bias-aligned trades are untouched.
 * The veto only applies to bars from 10:00 ET onward (the bias window
 * must be complete — no lookahead on 9:30–9:59 tickets).
 *
 * Two panels, same replay core (first-touch, 60-bar time exit, 0.5 pt
 * cost, one position at a time):
 *   SOFT  — the live RTH card (detectSoftMomentum, SOFT_PROD, 0.75R)
 *   LITE  — the rthDayBias detector (buy-frac 0.6 / vol ≥ 0.5×med60,
 *           1R) so the veto is comparable to the global-filter numbers
 *
 *   node --import ../scripts/ts-loader.mjs scripts/counterBiasVeto.ts \
 *     [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { closeOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import {
  scoreTrade,
  coreStats,
  wilson95,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
} from "../lib/backtestEngine";

const COST = 0.5;
const HOLD_BARS = 60;
const THRESHOLDS = [300, 500, 800];
const SPLIT = "2026-01-01";

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
const inRTH = (t: string): boolean => {
  const h = hourET(t);
  const mm = mmOf(t);
  return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

type T = { date: string; hourET: number; mm: number; dir: "long" | "short"; pnlPts: number; riskPts: number; bias: number };

/* ---- replay cores ------------------------------------------------- */

function replaySignals(minutes: MomMinute[], sigs: MomentumSignal[], bias: number): T[] {
  const out: T[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const dir = s.dir === "long" ? 1 : -1;
    // the consolidated engine's canonical scorer (pessimistic stop-first,
    // 0.5 pt cost, 60-bar time exit, closeOf midpoint fallback) — semantics
    // identical to the former local loop: last-bar signals drop, one-at-a-time
    // window is the full HOLD_BARS regardless of the actual exit.
    const sc = scoreTrade(
      minutes,
      { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk: Math.abs(s.entry - s.stop) },
      { costPts: COST, holdBars: HOLD_BARS },
    );
    if (!sc) continue;
    out.push({
      date: s.d,
      hourET: s.hourET,
      mm: mmOf(s.t),
      dir: s.dir,
      pnlPts: sc.pnl,
      riskPts: sc.risk,
      bias,
    });
    openUntil = s.entryIdx + HOLD_BARS;
  }
  return out;
}

/** the rthDayBias lite detector (1R) — same rules, same replay shape */
function detectLite(minutes: MomMinute[]): MomentumSignal[] {
  const n = minutes.length;
  const out: MomentumSignal[] = [];
  const med = (i: number): number => {
    const arr: number[] = [];
    for (let j = Math.max(0, i - 60); j < i; j++) arr.push(minutes[j].buy + minutes[j].sell);
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  let last = -100;
  for (let k = 20; k < n - 1; k++) {
    if (!inRTH(minutes[k].t)) continue;
    if (k - last < 5) continue;
    const m = minutes[k];
    const vol = m.buy + m.sell;
    if (vol < 0.5 * med(k)) continue;
    const frac = vol > 0 ? m.buy / vol : 0.5;
    let dir: "long" | "short" | null = null;
    if (frac >= 0.6) dir = "long";
    else if (frac <= 0.4) dir = "short";
    if (!dir) continue;
    const entry = closeOf(m);
    const stop = dir === "long" ? m.low - 1 : m.high + 1;
    const risk = Math.abs(entry - stop);
    if (risk <= 0 || risk > 15) continue;
    out.push({
      dir, kind: "flush", flushIdx: k, respIdx: k, breakIdx: k, entryIdx: k,
      entry, stop, target: dir === "long" ? entry + risk : entry - risk, risk,
      t: m.t, d: m.d, hourET: hourET(m.t),
      flushFrac: frac, flushVol: vol, flushRange: 0, failDepth: 0,
      respFrac: frac, respVol: vol, respDelay: 1, respProof: 0,
      breakFrac: frac, breakVol: vol, breakDelay: 1, refDist: 0, progressPts: 0,
      medVol: med(k), distVwapPts: 0, cumDelta: 0, deltaFromFlush: 0,
      atr14: 0, riskPts: risk,
      trailLowDist: 0, trailHighDist: 0, breakRangeR: 0, breakStack: "none",
      breakVwapPos: 0.5, flushRangeR: 0,
    });
    last = k;
  }
  return out;
}

/* ---- bias + variants ---------------------------------------------- */

/** day bias = cumulative delta of 9:30–10:00 (0 when the window is empty) */
function dayBias(minutes: MomMinute[]): number {
  let bias = 0;
  for (const m of minutes) {
    if (!inRTH(m.t)) continue;
    const h = hourET(m.t);
    if (h === 9 || (h === 10 && mmOf(m.t) === 0)) bias += m.buy - m.sell;
    else if (h > 10) break;
  }
  return bias;
}

function vetoed(t: T, thresh: number): boolean {
  if (t.hourET < 10) return false; // bias window incomplete before 10:00
  if (t.bias >= thresh && t.dir === "short") return true;
  if (t.bias <= -thresh && t.dir === "long") return true;
  return false;
}

function stats(tt: T[]) {
  const wins = tt.filter((t) => t.pnlPts > 0);
  const losses = tt.filter((t) => t.pnlPts < 0);
  const gw = wins.reduce((a, t) => a + t.pnlPts, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlPts, 0));
  const net = tt.reduce((a, t) => a + t.pnlPts, 0);
  const decided = wins.length + losses.length;
  return {
    n: tt.length,
    wr: decided ? (wins.length / decided) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net,
    exp: tt.length ? net / tt.length : 0,
  };
}

function row(label: string, s: ReturnType<typeof stats>, expBase?: number): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : " inf";
  const d = expBase === undefined ? "" : ` (Δexp ${s.exp - expBase >= 0 ? "+" : ""}${(s.exp - expBase).toFixed(2)} vs base)`;
  return `${label.padEnd(26)} | n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} net=${s.net.toFixed(0).padStart(8)} exp=${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(5)}/t${d}`;
}

function accountSim(tt: T[]): string {
  const d = dollarize(tt.map((t) => ({ date: t.date, pnlPts: t.pnlPts, riskPts: t.riskPts })));
  const s = simulateAccount(d, "eval");
  return `eval: ${accountLine(s)}`;
}

function panel(name: string, trades: T[]) {
  const base = trades;
  console.log(`\n=== ${name} — counter-bias veto (bias = 9:30–10:00 cum delta) ===`);
  console.log(`  ${row("base (all)", stats(base))}`);
  for (const T of THRESHOLDS) {
    const kept = base.filter((t) => !vetoed(t, T));
    const skipped = base.filter((t) => vetoed(t, T));
    console.log(`  ${row(`veto |bias|≥${T}`, stats(kept), stats(base).exp)}`);
    console.log(`  ${row(`  └ skipped cell`, stats(skipped))}`);
  }
  const aligned = base.filter((t) => (t.bias >= 500 && t.dir === "long") || (t.bias <= -500 && t.dir === "short"));
  console.log(`  ${row("with-bias cell (≥500)", stats(aligned))}`);
  const byYear = ["2024", "2025", "2026"].map((y) => {
    const b = stats(base.filter((t) => t.date.startsWith(y)));
    const v = stats(base.filter((t) => t.date.startsWith(y) && !vetoed(t, 500)));
    return `${y}: base wr=${b.wr.toFixed(1)}% exp=${b.exp >= 0 ? "+" : ""}${b.exp.toFixed(2)} → veto wr=${v.wr.toFixed(1)}% exp=${v.exp >= 0 ? "+" : ""}${v.exp.toFixed(2)}`;
  });
  console.log(`  per-year (veto@500):`);
  for (const l of byYear) console.log(`    ${l}`);
  console.log(`  ${accountSim(base).replace("eval: ", "account ")}(base)`);
  console.log(`  ${accountSim(base.filter((t) => !vetoed(t, 500))).replace("eval: ", "account ")}(veto@500)`);
  const tr = stats(base.filter((t) => t.date < SPLIT));
  const te = stats(base.filter((t) => t.date >= SPLIT));
  const trV = stats(base.filter((t) => t.date < SPLIT && !vetoed(t, 500)));
  const teV = stats(base.filter((t) => t.date >= SPLIT && !vetoed(t, 500)));
  console.log(`  train/test (veto@500): TRAIN exp ${tr.exp >= 0 ? "+" : ""}${tr.exp.toFixed(2)} → ${trV.exp >= 0 ? "+" : ""}${trV.exp.toFixed(2)} | TEST exp ${te.exp >= 0 ? "+" : ""}${te.exp.toFixed(2)} → ${teV.exp >= 0 ? "+" : ""}${teV.exp.toFixed(2)}`);
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
  console.log(`counter-bias veto · ${dates.length} sessions · first-touch, 60-bar, 0.5pt cost`);

  const soft: T[] = [];
  const lite: T[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { minutes } of sessions) {
      if (!minutes) continue;
      const bias = dayBias(minutes);
      soft.push(...replaySignals(minutes, detectSoftMomentum(minutes, SOFT_PROD), bias));
      lite.push(...replaySignals(minutes, detectLite(minutes), bias));
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  panel("SOFT (live RTH card, 0.75R)", soft);
  panel("LITE (rthDayBias detector, 1R)", lite);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Primary cohort = SOFT (the live RTH card the veto is proposed for).
   * NOTE: the legacy stats() above uses a "decided" WR denominator (wins +
   * losses, pnl===0 excluded), so it is kept untouched; the engine rows use
   * the standard n denominator. ---- */
  const splitDate = SPLIT;
  const eng = (ts: T[]) => ts.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const engineTrades = eng(soft);
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([
    { label: "all", stats: coreStats(engineTrades) },
    { label: "train", stats: coreStats(engineTrades.filter((t) => t.date < splitDate)) },
    { label: "test", stats: coreStats(engineTrades.filter((t) => t.date >= splitDate)) },
  ]));
  {
    const base = coreStats(engineTrades);
    const cells: { name: string; trades: ReturnType<typeof eng> }[] = [
      { name: "base (all)", trades: engineTrades },
      { name: "veto |bias|≥300", trades: eng(soft.filter((t) => !vetoed(t, 300))) },
      { name: "veto |bias|≥500", trades: eng(soft.filter((t) => !vetoed(t, 500))) },
      { name: "veto |bias|≥800", trades: eng(soft.filter((t) => !vetoed(t, 800))) },
      { name: "with-bias cell (≥500)", trades: eng(soft.filter((t) => (t.bias >= 500 && t.dir === "long") || (t.bias <= -500 && t.dir === "short"))) },
    ];
    console.log("\n" + renderT2(cells.map((c) => {
      const s = coreStats(c.trades);
      const tr = coreStats(c.trades.filter((t) => t.date < splitDate));
      const te = coreStats(c.trades.filter((t) => t.date >= splitDate));
      return {
        rule: c.name,
        n: s.n,
        wr: s.wr,
        ci: wilson95(s.wins, s.n),
        pf: s.pf,
        expPts: s.expPts,
        trainTest: `${tr.wr.toFixed(0)}% / ${te.wr.toFixed(0)}%`,
        compare: c.name === "base (all)" ? "—" : `base WR ${base.wr.toFixed(1)}%`,
      };
    })));
  }
  const viability = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(viability));
  const trainStats = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const testStats = coreStats(engineTrades.filter((t) => t.date >= splitDate));
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
