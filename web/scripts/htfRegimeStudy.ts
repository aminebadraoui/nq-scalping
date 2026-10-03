/* ------------------------------------------------------------------ *
 * HTF-regime study — do counter-trend SHORTS (shorts fired while the
 * higher-timeframe trend is bullish) carry the losing edge?
 *
 * Replays the prod detectors (momentum flush + expansion, optional RTH
 * soft) over the R2 archive, tags every signal with lookahead-free
 * higher-timeframe regime features computed from the session tape:
 *
 *   bull15 / bear15  — 15m EMA20 vs EMA50 (mid closes) + 4-bucket slope
 *   above200 / ema200Rising — 1m EMA200 position + 30-bar slope
 *   sessRet / cumD / aboveVwap — session open ret, cum delta, VWAP side
 *   prevDayRet — prior session close → this session open (daily trend)
 *   pullbackInUptrend — bull15 but the last hour retraced (ret60<0)
 *                        while the 4-hour tape still advanced (ret240>0)
 *
 * then runs veto variants: skip SHORTS in bullish regimes (and the
 * symmetric long-side check), reporting the vetoed subset's own stats
 * (does the gate remove a genuinely worse subset?) plus train/test and
 * the MFF Rapid EOD 50k account sim.
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs ./scripts/htfRegimeStudy.ts \
 *        [--max N] [--split 2026-01-01] [--include-rth] [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
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
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split: string; dump?: string; includeRth: boolean } = {
    split: "2026-01-01",
    includeRth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--include-rth") o.includeRth = true;
  }
  return o;
}

/* ---------------- regime context (lookahead-free) ---------------- */

type RegimeCtx = {
  mid: number[];
  ema200: number[];
  ema200Prev30: number[];
  vwap: number[];
  cumD: number[];
  // 15m buckets: endIdx of each completed bucket + its mid close
  bucketEnd: number[];
  bucketMid: number[];
  bucketEma20: number[];
  bucketEma50: number[];
  sessionOpenMid: number;
  prevDayRet: number | null;
};

function buildContext(minutes: MomMinute[], prevLastMid: number | null): RegimeCtx {
  const n = minutes.length;
  const mid: number[] = new Array(n);
  const ema200: number[] = new Array(n);
  const ema200Prev30: number[] = new Array(n);
  const vwap: number[] = new Array(n);
  const cumD: number[] = new Array(n);
  let e = 0, cumV = 0, cum = 0;
  const k = 2 / 201;
  for (let i = 0; i < n; i++) {
    const m = minutes[i];
    mid[i] = closeOf(m);
    e = e === 0 ? mid[i] : e + k * (mid[i] - e);
    ema200[i] = e;
    ema200Prev30[i] = i >= 30 ? ema200[i - 30] : ema200[i];
    const vol = m.buy + m.sell;
    cumV += mid[i] * vol;
    cum += vol;
    vwap[i] = cum > 0 ? cumV / cum : mid[i];
    cumD[i] = (i > 0 ? cumD[i - 1] : 0) + (m.buy - m.sell);
  }

  const bucketEnd: number[] = [];
  const bucketMid: number[] = [];
  for (let i = 14; i < n; i += 15) {
    bucketEnd.push(i);
    bucketMid.push(mid[i]);
  }
  const nb = bucketMid.length;
  const bucketEma20: number[] = new Array(nb);
  const bucketEma50: number[] = new Array(nb);
  if (nb > 0) {
    let e20 = bucketMid[0], e50 = bucketMid[0];
    const k20 = 2 / 21, k50 = 2 / 51;
    for (let i = 0; i < nb; i++) {
      e20 = i === 0 ? e20 : e20 + k20 * (bucketMid[i] - e20);
      e50 = i === 0 ? e50 : e50 + k50 * (bucketMid[i] - e50);
      bucketEma20[i] = e20;
      bucketEma50[i] = e50;
    }
  }

  return {
    mid, ema200, ema200Prev30, vwap, cumD,
    bucketEnd, bucketMid, bucketEma20, bucketEma50,
    sessionOpenMid: mid[0],
    prevDayRet: prevLastMid !== null ? mid[0] - prevLastMid : null,
  };
}

type RegimeTags = {
  bull15: boolean;
  bear15: boolean;
  above200: boolean;
  ema200Rising: boolean;
  sessRet: number;
  cumD: number;
  aboveVwap: boolean;
  prevDayRet: number | null;
  ret60: number;
  ret240: number;
  entryMinusE20_15: number;
  entryMinusSessionHigh: number;
  pullbackInUptrend: boolean;
  bucketIdx: number;
  early: boolean; // EMA warmup not credible — regime classes undefined
};

function tagRegime(ctx: RegimeCtx, entryIdx: number, entry: number): RegimeTags | null {
  const { mid, ema200, ema200Prev30, vwap, cumD, bucketEnd, bucketEma20, bucketEma50 } = ctx;
  // last completed 15m bucket at or before the entry bar
  let b = -1;
  for (let k = 0; k < bucketEnd.length; k++) {
    if (bucketEnd[k] <= entryIdx) b = k;
    else break;
  }
  if (b < 0) return null;
  const mature = b >= 4;
  let e20 = bucketEma20[b];
  let e50 = bucketEma50[b];
  let e20Prev = mature ? bucketEma20[b - 4] : e20;
  const bull15 = mature && e20 > e50 && e20 >= e20Prev;
  const bear15 = mature && e20 < e50 && e20 <= e20Prev;
  let sessHigh = -Infinity;
  for (let i = 0; i <= entryIdx; i++) sessHigh = Math.max(sessHigh, ctx.mid[i]);
  const ret60 = entry - mid[Math.max(0, entryIdx - 60)];
  const ret240 = entry - mid[Math.max(0, entryIdx - 240)];
  return {
    bull15, bear15,
    above200: entry > ema200[entryIdx],
    ema200Rising: ema200[entryIdx] >= ema200Prev30[entryIdx],
    sessRet: entry - ctx.sessionOpenMid,
    cumD: cumD[entryIdx],
    aboveVwap: entry > vwap[entryIdx],
    prevDayRet: ctx.prevDayRet,
    ret60, ret240,
    entryMinusE20_15: entry - e20,
    entryMinusSessionHigh: entry - sessHigh,
    pullbackInUptrend: bull15 && ret60 < 0 && ret240 > 0,
    bucketIdx: b,
    early: !mature,
  };
}

/* ---------------- trade scoring (same rules as momentumStudy) ------- */

type ScoredTrade = MomentumSignal & {
  date: string;
  exit: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
  mfeR: number;
  maeR: number;
  regime: RegimeTags;
  src: "flush" | "expansion" | "rth";
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, regime: RegimeTags, src: ScoredTrade["src"]): ScoredTrade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;
  let hit: ScoredTrade["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.entryIdx;
  let mfe = 0, mae = 0;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav / risk);
    mae = Math.max(mae, adv / risk);
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - sig.entryIdx;
      break;
    }
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - sig.entryIdx;
      break;
    }
  }
  const pnl = (exit - entry) * dir - COST_PTS;
  return { ...sig, date, exit, pnl, hit, heldBars, mfeR: mfe, maeR: mae, regime, src };
}

function scoreSequential(minutes: MomMinute[], signals: { sig: MomentumSignal; regime: RegimeTags; src: ScoredTrade["src"] }[], date: string): ScoredTrade[] {
  const out: ScoredTrade[] = [];
  let openUntil = -1;
  for (const { sig, regime, src } of signals) {
    if (sig.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, sig, date, regime, src);
    if (!sc) continue;
    out.push(sc);
    openUntil = sc.entryIdx + sc.heldBars;
  }
  return out;
}

/* ---------------- stats ---------------- */

type Stats = {
  n: number; wins: number; wr: number; pf: number; avgPts: number; expR: number;
  netPts: number; sessions: number;
};

function stats(trades: ScoredTrade[]): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    wins: wins.length,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgPts: n ? net / n : 0,
    expR: n ? trades.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0,
    netPts: net,
    sessions: new Set(trades.map((t) => t.date)).size,
  };
}

function fmt(s: Stats): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return [
    `n=${String(s.n).padStart(5)}`,
    `wr=${s.wr.toFixed(1).padStart(5)}%`,
    `pf=${pf.padStart(5)}`,
    `avgPts=${s.avgPts.toFixed(2).padStart(6)}`,
    `expR=${s.expR.toFixed(2).padStart(5)}`,
    `net=${s.netPts.toFixed(0).padStart(7)}pts`,
    `sess=${s.sessions}`,
  ].join(" ");
}

/* ---------------- veto variants ---------------- */

type Veto = { name: string; skip: (t: ScoredTrade) => boolean };

function makeVetoes(): Veto[] {
  const r = (t: ScoredTrade) => t.regime;
  return [
    { name: "base", skip: () => false },
    {
      name: "noShortBull15",
      skip: (t) => t.dir === "short" && r(t).bull15,
    },
    {
      name: "noShortBull15+A200",
      skip: (t) => t.dir === "short" && r(t).bull15 && r(t).above200,
    },
    {
      name: "noShortPullbackUp",
      skip: (t) => t.dir === "short" && r(t).pullbackInUptrend,
    },
    {
      name: "noShortBelowE20Bull",
      skip: (t) => t.dir === "short" && r(t).bull15 && r(t).entryMinusE20_15 < 0,
    },
    {
      name: "noShortMixed",
      skip: (t) => t.dir === "short" && !r(t).bull15 && !r(t).bear15 && !r(t).early,
    },
    {
      name: "noShortVwapBelow",
      skip: (t) => t.dir === "short" && !r(t).aboveVwap,
    },
    {
      name: "noShortVwapBelowBull",
      skip: (t) => t.dir === "short" && r(t).bull15 && !r(t).aboveVwap,
    },
    {
      name: "noShortVwapBelowNoBull",
      skip: (t) => t.dir === "short" && !r(t).bull15 && !r(t).aboveVwap,
    },
    {
      name: "noShortCumD>0",
      skip: (t) => t.dir === "short" && r(t).cumD > 0,
    },
    {
      name: "noLongBear15",
      skip: (t) => t.dir === "long" && r(t).bear15,
    },
    {
      name: "bothSides",
      skip: (t) =>
        (t.dir === "short" && r(t).bull15 && r(t).above200) ||
        (t.dir === "long" && r(t).bear15 && !r(t).above200),
    },
  ];
}

/* ---------------- main ---------------- */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let dates = await archiveDates();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions · split ${o.split} · rth=${o.includeRth}`);

  const vetoes = makeVetoes();
  const perVariant: ScoredTrade[][] = vetoes.map(() => []);
  const perVariantVetoed: ScoredTrade[][] = vetoes.map(() => []);
  const baseSignals: { date: string; sig: MomentumSignal; regime: RegimeTags }[] = [];

  let prevLastMid: number | null = null;
  let prevDate: string | null = null;
  let loaded = 0, failed = 0;
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(
      chunk.map(async (date) => {
        const minutes = await loadSessionMinutes(date);
        return { date, minutes };
      }),
    );
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      const ctx = buildContext(minutes, prevLastMid);
      prevLastMid = closeOf(minutes[minutes.length - 1]);
      prevDate = date;

      const mom = detectMomentum(minutes, MOM_PROD).map((s) => ({ sig: s, src: "flush" as const }));
      const exp = detectExpansionScalp(minutes, EXP_PROD).map((s) => ({ sig: s, src: "expansion" as const }));
      const raw: { sig: MomentumSignal; src: ScoredTrade["src"] }[] = [...mom, ...exp];
      if (o.includeRth) raw.push(...detectSoftMomentum(minutes, SOFT_PROD).map((s) => ({ sig: s, src: "rth" as const })));

      const tagged: { sig: MomentumSignal; regime: RegimeTags; src: ScoredTrade["src"] }[] = [];
      for (const { sig, src } of raw) {
        const regime = tagRegime(ctx, sig.entryIdx, sig.entry);
        if (!regime) continue; // EMA warmup not credible
        tagged.push({ sig, regime, src });
      }
      const base = scoreSequential(minutes, tagged, date);
      for (const t of base) baseSignals.push({ date, sig: t, regime: t.regime });

      for (let v = 0; v < vetoes.length; v++) {
        const kept: typeof tagged = [];
        const vetoed: typeof tagged = [];
        for (const tg of tagged) {
          // apply the veto on the SIGNAL before scoring so the sequential
          // replay is honest (a vetoed signal frees the lane for the next)
          const provisional = { ...tg.sig, pnl: 0, hit: "time", exit: 0, heldBars: 0, mfeR: 0, maeR: 0, date, regime: tg.regime, src: tg.src } as ScoredTrade;
          if (vetoes[v].skip(provisional)) vetoed.push(tg);
          else kept.push(tg);
        }
        perVariant[v].push(...scoreSequential(minutes, kept, date));
        perVariantVetoed[v].push(...scoreSequential(minutes, vetoed, date));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} loaded · ${failed} failed`);

  /* ---- baseline: side × regime matrix ---- */
  console.log("\n=== BASELINE side × regime (all families, sequential) ===");
  const cells = new Map<string, ScoredTrade[]>();
  for (const t of perVariant[0]) {
    const reg = t.regime.early ? "EARLY" : t.regime.bull15 ? "BULL15" : t.regime.bear15 ? "BEAR15" : "MIXED";
    const k = `${t.dir}|${reg}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(t);
  }
  for (const [k, list] of [...cells.entries()].sort()) {
    console.log(`  ${k.padEnd(16)} ${fmt(stats(list))}`);
  }

  console.log("\n=== BASELINE side × regime by family ===");
  for (const fam of ["flush", "expansion", "rth"] as const) {
    const famTrades = perVariant[0].filter((t) => t.src === fam);
    if (!famTrades.length) continue;
    console.log(`\n--- family ${fam} (n=${famTrades.length}) ---`);
    const fc = new Map<string, ScoredTrade[]>();
    for (const t of famTrades) {
      const reg = t.regime.early ? "EARLY" : t.regime.bull15 ? "BULL15" : t.regime.bear15 ? "BEAR15" : "MIXED";
      const k = `${t.dir}|${reg}`;
      if (!fc.has(k)) fc.set(k, []);
      fc.get(k)!.push(t);
    }
    for (const [k, list] of [...fc.entries()].sort()) {
      console.log(`  ${k.padEnd(16)} ${fmt(stats(list))}`);
    }
  }

  /* ---- the hypothesis: shorts inside a bullish HTF pullback ---- */
  console.log("\n=== SHORT losses in BULL15 regime — where were they? ===");
  const shortBull = perVariant[0].filter((t) => t.dir === "short" && t.regime.bull15);
  const shortBullLoss = shortBull.filter((t) => t.pnl <= 0);
  const shortBullWin = shortBull.filter((t) => t.pnl > 0);
  console.log(`  shorts in BULL15: n=${shortBull.length}  wins=${shortBullWin.length}  losses=${shortBullLoss.length}`);
  console.log(`  of the losses:`);
  const pb = shortBullLoss.filter((t) => t.regime.pullbackInUptrend);
  const belowE20 = shortBullLoss.filter((t) => t.regime.entryMinusE20_15 < 0);
  const above200loss = shortBullLoss.filter((t) => t.regime.above200);
  console.log(`    pullbackInUptrend (ret60<0, ret240>0): ${pb.length}/${shortBullLoss.length}  → ${fmt(stats(pb))}`);
  console.log(`    entry below 15m EMA20: ${belowE20.length}/${shortBullLoss.length}  → ${fmt(stats(belowE20))}`);
  console.log(`    entry above EMA200: ${above200loss.length}/${shortBullLoss.length}  → ${fmt(stats(above200loss))}`);
  const hourDist = new Map<number, ScoredTrade[]>();
  for (const t of shortBullLoss) {
    const h = t.hourET;
    if (!hourDist.has(h)) hourDist.set(h, []);
    hourDist.get(h)!.push(t);
  }
  console.log("    by hour (ET): " + [...hourDist.entries()].sort((a, b) => a[0] - b[0]).map(([h, l]) => `${h}:00×${l.length}`).join("  "));

  /* ---- veto variants ---- */
  console.log("\n=== VETO VARIANTS (all | train<split | test≥split | vetoed-subset) ===");
  for (let v = 0; v < vetoes.length; v++) {
    const all = perVariant[v];
    const vetoed = perVariantVetoed[v];
    const train = all.filter((t) => t.date < o.split);
    const test = all.filter((t) => t.date >= o.split);
    console.log(`${vetoes[v].name.padEnd(20)} | ALL   ${fmt(stats(all))}`);
    console.log(`${"".padEnd(20)} | TRAIN ${fmt(stats(train))}`);
    console.log(`${"".padEnd(20)} | TEST  ${fmt(stats(test))}`);
    if (v > 0) console.log(`${"".padEnd(20)} | VETOED ${fmt(stats(vetoed))}  (${((vetoed.length / (all.length + vetoed.length)) * 100).toFixed(0)}% of signals)`);
  }

  /* ---- account sim ---- */
  console.log("\nACCOUNT (Rapid EOD 50k · $170/trade budget · 30-micro cap):");
  for (let v = 0; v < vetoes.length; v++) {
    const trades = perVariant[v];
    const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const evalAll = simulateAccount(d, "eval");
    const fundedTest = simulateAccount(d.filter((t) => t.date >= o.split), "funded");
    const dollarNet = d.reduce((a, t) => a + t.pnl, 0);
    console.log(`${vetoes[v].name.padEnd(20)} | net $${dollarNet.toFixed(0).padStart(7)} · eval[all] ${accountLine(evalAll)} · funded[test] ${accountLine(fundedTest)}`);
  }

  /* ---- context-aware SIZING (no veto — trade, but size by regime tier) ----
   * dollarize derives contracts from riskPts at a fixed budget; halving the
   * pnlPts of a tier is exactly a half-size fill of the same trades. */
  console.log("\nSIZING VARIANTS (same trades as base, weak-tier shorts at half size):");
  const rr = (t: ScoredTrade) => t.regime;
  const weakShort = (t: ScoredTrade) =>
    t.dir === "short" && ((rr(t).bull15 && !rr(t).aboveVwap) || (!rr(t).bull15 && !rr(t).bear15 && !rr(t).early));
  const sizingVariants: { name: string; scale: (t: ScoredTrade) => number }[] = [
    { name: "size base", scale: () => 1 },
    { name: "halfShortBull15", scale: (t) => (t.dir === "short" && rr(t).bull15 ? 0.5 : 1) },
    { name: "halfShortBull15+A200", scale: (t) => (t.dir === "short" && rr(t).bull15 && rr(t).above200 ? 0.5 : 1) },
    { name: "halfShortVwapBelow", scale: (t) => (t.dir === "short" && !rr(t).aboveVwap ? 0.5 : 1) },
    { name: "halfShortVwapBelowBull", scale: (t) => (t.dir === "short" && rr(t).bull15 && !rr(t).aboveVwap ? 0.5 : 1) },
    { name: "halfWeakShortTier", scale: (t) => (weakShort(t) ? 0.5 : 1) },
    { name: "halfShortPullbackUp", scale: (t) => (t.dir === "short" && rr(t).pullbackInUptrend ? 0.5 : 1) },
    { name: "zeroWeakShortTier", scale: (t) => (weakShort(t) ? 0 : 1) },
  ];
  for (const sv of sizingVariants) {
    const baseTrades = perVariant[0];
    const scaled = baseTrades.map((t) => ({ date: t.date, pnlPts: t.pnl * sv.scale(t), riskPts: t.risk }));
    const d = dollarize(scaled);
    const evalAll = simulateAccount(d, "eval");
    const fundedTest = simulateAccount(d.filter((t) => t.date >= o.split), "funded");
    const dollarNet = d.reduce((a, t) => a + t.pnl, 0);
    let worstDay = 0, worstDayDate = "";
    for (const day of evalAll.days) {
      if (day.pnl < worstDay) {
        worstDay = day.pnl;
        worstDayDate = day.date;
      }
    }
    let peak = 0, maxDD = 0;
    for (const day of evalAll.days) {
      peak = Math.max(peak, day.equity);
      maxDD = Math.min(maxDD, day.equity - peak);
    }
    console.log(
      `${sv.name.padEnd(22)} | net $${dollarNet.toFixed(0).padStart(7)} · worstDay $${worstDay.toFixed(0).padStart(6)} (${worstDayDate}) · maxDD $${maxDD.toFixed(0).padStart(7)} · ` +
      `eval ${accountLine(evalAll)}`,
    );
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify({
        generated: new Date().toISOString(),
        split: o.split,
        includeRth: o.includeRth,
        vetoes: vetoes.map((v) => v.name),
        base: perVariant[0].map((t) => ({
          date: t.date, dir: t.dir, kind: t.kind, hourET: t.hourET,
          entry: t.entry, stop: t.stop, target: t.target, risk: t.risk,
          pnl: t.pnl, hit: t.hit, mfeR: t.mfeR, maeR: t.maeR,
          regime: t.regime,
        })),
        variants: Object.fromEntries(vetoes.map((v, idx) => [v.name, perVariant[idx].map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))])),
      }, null, 1),
    );
    console.log(`\ndumped → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
