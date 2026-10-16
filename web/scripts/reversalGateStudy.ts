/* ------------------------------------------------------------------ *
 * Reversal price-action gate study — does the PA vote earn its seat?
 *
 * Replays the LVN-reversal card over the R2 archive, bar by bar, with
 * the LIVE pipeline (lib/mechanism readMechanism + lib/priceaction
 * readPriceAction + lib/signals composeSignals/cardGateOpen) and the
 * live feed's footprint filters (aligned stack + entry-bar delta).
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/reversalGateStudy.ts [--max N] [--split 2026-01-01] \
 *     [--warm] [--dump out.json]
 *
 * Two arms, identical except the box alignment:
 *   A  current  — cardGateOpen over [Order flow + Price action]:
 *                 PA must VOTE THE SAME SIDE (neutral blocks as
 *                 "not every box has voted", opposite blocks as
 *                 CONFLICT). This is the shipped gate.
 *   B  proposed — cardGateOpen over [Order flow] only: PA is removed
 *                 from the gate entirely (it still renders, never votes).
 *
 * Both arms carry the live maybeSend footprint filters and the
 * one-trade-at-a-time overlay (60s flat-gate latch = minGapBars 1).
 * Trade model (the shipped reversal ticket): entry at the trigger
 * bar's midpoint, 7-pt scalp stop, nearest-POC target, 0.5 pt
 * round-trip cost, pessimistic stop-first scoring, 60-bar time exit
 * (lib/backtestEngine scoreTrade/scoreSequential).
 *
 * Replay honesty (documented in the report):
 *   · ~2–3-bar lookahead in the event detections (reclaim confirms
 *     over the next 2 bars; absorption progress over the next 3;
 *     divergence pivots are ±2-bar local extremes) — the same caveat
 *     the original FOOTPRINT_REVERSAL_RESEARCH harness carried.
 *   · Event DETECTION is precomputed once per session; the per-bar
 *     readMechanism/readPriceAction/gate evaluation is rolling and
 *     uses only events stamped ≤ t (ages via a full-session index).
 *   · Location level stack = prior-day RTH + prior-day ETH + 5-day
 *     RTH composite, built from the archive (lookahead-free), plus
 *     the rolling developing P0 profile exactly as the live pipeline.
 *   · No gamma/options box (context-only, never votes; data does not
 *     exist historically). No news-window veto (context = "yes").
 *   · RTH only (09:30–16:00 ET, bars 08:30–15:59 on the feed clock),
 *     matching the original reversal study's 683-session sample.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates, warmArchive, cacheDir } from "../lib/archive";
import { aggregate, stats, analyzeMinutes, type FootprintMinute } from "../lib/gcdata";
import { imbalanceFor, summarizeImb } from "../lib/imbalance";
import { readMechanism } from "../lib/mechanism";
import { readPriceAction } from "../lib/priceaction";
import { composeSignals, boxFromMechanism, boxFromPriceAction, cardGateOpen } from "../lib/signals";
import {
  scoreTrade,
  scoreSequential,
  coreStats,
  propViability,
  wilson95,
  renderT0,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  byYear,
  type EngineTrade,
} from "../lib/backtestEngine";
import type { MomMinute } from "../lib/momentum";

/* ---------------- constants ---------------- */

const COST_PTS = 0.5;
const HOLD_BARS = 60;
const STOP_PTS = 7;
const TICK = 25; // cents (0.25 pt)
const ROW_TICKS = 4;
const START_BAR = 15; // replay starts once the mechanism has a real window
// (enough for ±2-bar divergence pivots, 6-bar stack age, 3-bar absorption
//  progress — and it keeps the 09:30 ET open hour inside the RTH replay)
const PA_WINDOW_BARS = 240; // the longest calendar bucket (4h) fully fits
const RTH_FROM = "08:30"; // RTH open on the feed clock (fixed CDT convention: 09:30 ET)
const RTH_TO = "14:59"; // last RTH bar (15:59 ET close; 08:30–14:59 = the 390-bar session)
const MIN_GAP_BARS = 1; // the executor's 60s flat-entry latch at 1-min bars

/* ---------------- CLI ---------------- */

type Opts = {
  max?: number;
  split: string;
  dump?: string;
  warm: boolean;
  session: "rth" | "eth";
  hours?: number[]; // feed-clock hour whitelist (cards may only fire in these)
  stop: number;
  slip: number;
  slipSweep: boolean;
  byhourTrain: boolean;
};

function parseArgs(argv: string[]): Opts {
  const o: Opts = { split: "2026-01-01", warm: false, session: "rth", stop: STOP_PTS, slip: 0, slipSweep: false, byhourTrain: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--warm") o.warm = true;
    else if (a === "--session") o.session = argv[++i] === "eth" ? "eth" : "rth";
    else if (a === "--hours") o.hours = argv[++i].split(",").map((h) => Number(h.trim())).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);
    else if (a === "--stop") o.stop = Number(argv[++i]);
    else if (a === "--slip") o.slip = Number(argv[++i]);
    else if (a === "--slip-sweep") o.slipSweep = true;
    else if (a === "--byhour-train") o.byhourTrain = true;
  }
  return o;
}

/* ---------------- session → footprint minutes ---------------- */

const f2 = (n: number, dp = 2) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—";

function rthSlice(eth: MomMinute[]): MomMinute[] {
  return eth.filter((m) => m.t >= RTH_FROM && m.t <= RTH_TO);
}

function toFootprint(m: MomMinute): FootprintMinute {
  const levels = imbalanceFor(
    [...m.levels]
      .sort((a, b) => b.price - a.price)
      .map((l) => ({ price: l.price, buy: l.buy, sell: l.sell })),
  );
  return {
    t: m.t,
    d: m.d,
    o: m.o,
    c: m.c,
    high: m.high,
    low: m.low,
    buy: m.buy,
    sell: m.sell,
    delta: m.buy - m.sell,
    vwap: 0,
    levels,
    imb: summarizeImb(levels),
    src: "candle",
  };
}

/* the candle shape computeSignal builds for aggregate() */
function candlesOf(fp: FootprintMinute[]) {
  return fp.map((m) => ({
    t: `${m.d ?? "2020-01-01"}T${m.t}:00-05:00`,
    high: Math.round(m.high * 100),
    low: Math.round(m.low * 100),
    total: m.buy + m.sell,
    buy: m.buy,
    sell: m.sell,
    levels: Object.fromEntries(
      m.levels.map((l) => [String(Math.round(l.price * 100)), [l.buy + l.sell, l.buy, l.sell, 0, 0] as [number, number, number, number, number]]),
    ),
  }));
}

/* ---------------- prior-day level stack (lookahead-free) ---------------- */

type Edge = { label: string; p: number; zone: string };
type PocCand = { label: string; p: number };

type DayContext = { date: string; fpRth: FootprintMinute[]; fpEth: FootprintMinute[] };

function profileFrom(fp: FootprintMinute[]): { lvns: [number, number][]; poc: number } | null {
  if (fp.length < 60) return null;
  const rows = aggregate(candlesOf(fp), ROW_TICKS);
  const s = stats(rows);
  if (!s) return null;
  return { lvns: s.lvns, poc: s.poc / 100 };
}

/** the level stack the replay feeds readMechanism: prior-day RTH/ETH +
 *  5-day RTH composite — every input ≤ close of day D-1. */
function buildStaticContext(prior: DayContext[]): { edges: Edge[]; pocs: PocCand[] } {
  const edges: Edge[] = [];
  const pocs: PocCand[] = [];
  const rth = prior[prior.length - 1]?.fpRth ?? [];
  const eth = prior[prior.length - 1]?.fpEth ?? [];
  const rthP = profileFrom(rth);
  const ethP = profileFrom(eth);
  if (rthP) {
    for (const [a, b] of rthP.lvns) {
      const pa = a / 100;
      const pb = b / 100;
      const zone = `${f2(pa)}–${f2(pb)}`;
      edges.push({ label: "P4 Prior RTH", p: pa, zone }, { label: "P4 Prior RTH", p: pb, zone });
    }
    pocs.push({ label: "P4 Prior RTH POC", p: rthP.poc });
  }
  if (ethP) {
    for (const [a, b] of ethP.lvns) {
      const pa = a / 100;
      const pb = b / 100;
      const zone = `${f2(pa)}–${f2(pb)}`;
      edges.push({ label: "P2 Prior ETH", p: pa, zone }, { label: "P2 Prior ETH", p: pb, zone });
    }
    pocs.push({ label: "P2 Prior ETH POC", p: ethP.poc });
  }
  const comp = prior.slice(-5).flatMap((d) => d.fpRth);
  const compP = profileFrom(comp);
  if (compP) {
    for (const [a, b] of compP.lvns) {
      const pa = a / 100;
      const pb = b / 100;
      const zone = `${f2(pa)}–${f2(pb)}`;
      edges.push({ label: "P5 Composite", p: pa, zone }, { label: "P5 Composite", p: pb, zone });
    }
    pocs.push({ label: "P5 Composite POC", p: compP.poc });
  }
  return { edges, pocs };
}

/* ---------------- per-session replay ---------------- */

type RawSig = {
  date: string;
  dir: 1 | -1;
  entry: number;
  stop: number;
  target: number;
  entryIdx: number;
  risk: number;
  paVote: "same" | "neutral" | "opposite";
  /** reclaim identity of the episode (lastRec.t|price|dir) */
  key: string;
  t: string;
};

type SessionResult = {
  date: string;
  bars: number;
  sigA: RawSig[];
  sigB: RawSig[];
  /** PA vote classification at every bar where the OF-only gate opened */
  gateBPa: { same: number; neutral: number; opposite: number };
  gateBOk: number; // bars where gate B opened (before filters)
  gateAOk: number; // bars where gate A opened (before filters)
  filteredA: number; // bars dropped by the footprint filters (gate A ok)
  filteredB: number;
};

function replaySession(
  fp: FootprintMinute[],
  staticCtx: { edges: Edge[]; pocs: PocCand[] },
  date: string,
  hourAllow?: Set<number>,
): SessionResult {
  const n = fp.length;
  const res: SessionResult = {
    date,
    bars: n,
    sigA: [],
    sigB: [],
    gateBPa: { same: 0, neutral: 0, opposite: 0 },
    gateBOk: 0,
    gateAOk: 0,
    filteredA: 0,
    filteredB: 0,
  };

  // ---- precompute the full-session event structures once ----
  const candles = candlesOf(fp);
  const rows = aggregate(candles, ROW_TICKS);
  const s = stats(rows) ?? { total: 0, poc: 0, pocVolume: 0, vah: 0, val: 0, lvns: [] as [number, number][], nRows: 0 };
  let vnum = 0;
  let vden = 0;
  for (const m of fp) {
    const v = m.buy + m.sell;
    if (v <= 0) continue;
    vnum += ((m.high + m.low) / 2) * v;
    vden += v;
  }
  const vwapFull = vden > 0 ? vnum / vden : 0;
  const minPrice = Math.min(...fp.map((m) => m.low));
  const maxPrice = Math.max(...fp.map((m) => m.high));
  const analysis = analyzeMinutes(fp, minPrice, maxPrice, rows, s, vwapFull, ROW_TICKS, 0);
  const indexOf = new Map(fp.map((m, i) => [m.t, i] as const));
  const stacks = analysis.imbalance.stacks;

  // ---- rolling per-bar state ----
  const roll = new Map<number, { buy: number; sell: number }>();
  let sessHigh = -Infinity;
  let sessLow = Infinity;
  let vwNum = 0;
  let vwDen = 0;
  const firedA = new Set<string>();
  const firedB = new Set<string>();

  const rollAdd = (m: FootprintMinute) => {
    for (const l of m.levels) {
      const cents = Math.round(l.price * 100);
      const bucket = Math.round(cents / (TICK * ROW_TICKS)) * TICK * ROW_TICKS;
      const r = roll.get(bucket) ?? { buy: 0, sell: 0 };
      r.buy += l.buy;
      r.sell += l.sell;
      roll.set(bucket, r);
    }
  };

  for (let t = 0; t < n; t++) {
    const m = fp[t];
    const mid = (m.high + m.low) / 2;
    rollAdd(m);
    if (m.high > sessHigh) sessHigh = m.high;
    if (m.low < sessLow) sessLow = m.low;
    const v = m.buy + m.sell;
    if (v > 0) {
      vwNum += mid * v;
      vwDen += v;
    }
    if (t < START_BAR) continue;
    if (hourAllow && !hourAllow.has(Number(m.t.slice(0, 2)))) continue; // hour gate: no cards outside the whitelist

    const vwap = vwDen > 0 ? vwNum / vwDen : 0;
    const sRoll = stats(roll);
    if (!sRoll) continue;

    // rolling developing P0 profile (the live pipeline merges these)
    const lvnEdges: Edge[] = [...staticCtx.edges];
    for (const [a, b] of sRoll.lvns) {
      const pa = a / 100;
      const pb = b / 100;
      const zone = `${f2(pa)}–${f2(pb)}`;
      lvnEdges.push({ label: "P0 Live", p: pa, zone }, { label: "P0 Live", p: pb, zone });
    }
    const pocCands: PocCand[] = [...staticCtx.pocs];
    if (sRoll.poc > 0) pocCands.unshift({ label: "P0 Live POC", p: sRoll.poc / 100 });
    const nearestPoc = pocCands.length ? [...pocCands].sort((a, b) => Math.abs(a.p - mid) - Math.abs(b.p - mid))[0] : null;

    // ---- the two boxes (the live readMechanism/readPriceAction) ----
    const windowMins = fp.slice(0, t + 1).map((x) => ({ t: x.t, high: x.high, low: x.low, delta: x.buy - x.sell }));
    let stackAtT: (typeof stacks)[number] | null = null;
    for (let k = stacks.length - 1; k >= 0; k--) {
      const idx = indexOf.get(stacks[k].t);
      if (idx !== undefined && idx <= t) {
        stackAtT = stacks[k];
        break;
      }
    }
    const mech = readMechanism(
      {
        minutes: windowMins,
        lastPrice: mid,
        vwap,
        absorption: analysis.absorption,
        alerts: analysis.alerts,
        reclaims: analysis.reclaims,
        imbalance: { ...analysis.imbalance, lastStack: stackAtT },
        lvnEdges,
        poc: nearestPoc,
        sessionHigh: sessHigh,
        sessionLow: sessLow,
        newsWin: false,
      },
      indexOf,
    );

    const paMins = fp.slice(Math.max(0, t + 1 - PA_WINDOW_BARS), t + 1).map((x) => ({ high: x.high, low: x.low, t: x.t, d: x.d }));
    const pa = readPriceAction({ minutes: paMins, lastPrice: mid, sessionHigh: sessHigh, sessionLow: sessLow });

    // ---- the two gate arms ----
    const sigA = composeSignals([boxFromMechanism(mech), boxFromPriceAction(pa)]);
    const sigB = composeSignals([boxFromMechanism(mech)]);
    const gateA = cardGateOpen(sigA, mech);
    const gateB = cardGateOpen(sigB, mech);

    // the live maybeSend footprint filters (identical for both arms)
    const stackOk = !stackAtT || stackAtT.side === (mech.side === "long" ? "buy" : "sell");
    const deltaOk = mech.side === "long" ? mech.lastDelta > 0 : mech.side === "short" ? mech.lastDelta < 0 : false;
    const filtersOk = stackOk && deltaOk;

    if (gateB.ok) {
      res.gateBOk++;
      const vote = pa.side === null ? "neutral" : pa.side === mech.side ? "same" : "opposite";
      res.gateBPa[vote]++;
    }
    if (gateA.ok) res.gateAOk++;
    if (gateB.ok && !filtersOk) res.filteredB++;
    if (gateA.ok && !filtersOk) res.filteredA++;

    const record = (side: "long" | "short", key: string): RawSig | null => {
      if (!Number.isFinite(mech.targetPx)) return null;
      const dir: 1 | -1 = side === "long" ? 1 : -1;
      const entry = mid;
      const stop = side === "long" ? mid - STOP_PTS : mid + STOP_PTS;
      const target = mech.targetPx;
      if (dir > 0 && !(stop < entry && entry < target)) return null;
      if (dir < 0 && !(target < entry && entry < stop)) return null;
      const vote = pa.side === null ? "neutral" : pa.side === side ? "same" : "opposite";
      return { date, dir, entry, stop, target, entryIdx: t, risk: STOP_PTS, paVote: vote, key, t: m.t };
    };

    // the reclaim identity that gates the episode (same selection as readMechanism:
    // the last reclaim ≤20 bars old — never a future one)
    const idxOf = (tt: string) => indexOf.get(tt) ?? Infinity;
    const lastRec = [...analysis.reclaims].reverse().find((r) => {
      const i = idxOf(r.t);
      return i <= t && t - i <= 20;
    }) ?? null;

    if (gateA.ok && filtersOk && mech.side && lastRec) {
      const key = `${date}|${lastRec.t}|${lastRec.price}|${lastRec.dir}`;
      if (!firedA.has(key)) {
        firedA.add(key);
        const sig = record(mech.side, key);
        if (sig) res.sigA.push(sig);
      }
    }
    if (gateB.ok && filtersOk && mech.side && lastRec) {
      const key = `${date}|${lastRec.t}|${lastRec.price}|${lastRec.dir}`;
      if (!firedB.has(key)) {
        firedB.add(key);
        const sig = record(mech.side, key);
        if (sig) res.sigB.push(sig);
      }
    }
  }
  return res;
}

/* ---------------- scoring (per-session one-trade overlay) ---------------- */

function scoreArm(
  sigs: RawSig[],
  bars: Map<string, { high: number; low: number }[]>,
  cfg: { stop: number; slip: number } = { stop: STOP_PTS, slip: 0 },
): { trades: EngineTrade[]; hours: number[]; scored: number; dropped: number } {
  const byDate = new Map<string, RawSig[]>();
  for (const s of sigs) {
    const a = byDate.get(s.date);
    if (a) a.push(s);
    else byDate.set(s.date, [s]);
  }
  const trades: EngineTrade[] = [];
  const hours: number[] = [];
  let scored = 0;
  for (const [date, list] of byDate) {
    const mins = bars.get(date);
    if (!mins) continue;
    const outcomes = scoreSequential(
      list,
      (s) => {
        const stop = s.dir > 0 ? s.entry - cfg.stop : s.entry + cfg.stop;
        if (s.dir > 0 && !(stop < s.entry && s.entry < s.target)) return null;
        if (s.dir < 0 && !(s.target < s.entry && s.entry < stop)) return null;
        const sc = scoreTrade(
          mins.map((b) => ({ high: b.high, low: b.low, c: (b.high + b.low) / 2 })),
          { dir: s.dir, entry: s.entry, stop, target: s.target, entryIdx: s.entryIdx, risk: cfg.stop },
          { costPts: COST_PTS, holdBars: HOLD_BARS, stopSlipPts: cfg.slip },
        );
        return sc ? { ...sc, date: s.date, hour: Number(s.t.slice(0, 2)) } : null;
      },
      { occupy: "held", minGapBars: MIN_GAP_BARS },
    );
    scored += outcomes.length;
    for (const o of outcomes) {
      trades.push({ date: o.date, pnl: o.pnl, risk: o.risk });
      hours.push(o.hour);
    }
  }
  return { trades, hours, scored, dropped: sigs.length - scored };
}

function fmtStats(st: ReturnType<typeof coreStats>): string {
  const pf = Number.isFinite(st.pf) ? st.pf.toFixed(2) : "—";
  return `n=${st.n} wr=${st.wr.toFixed(1)}% pf=${pf} exp=${st.expPts.toFixed(2)}pts expR=${st.expR.toFixed(2)} maxDD=${st.maxDdPts.toFixed(0)}pts`;
}

/* ---------------- main ---------------- */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.warm) {
    console.log(`warming local archive (${cacheDir()})`);
    const res = await warmArchive({ concurrency: 16 });
    console.log(`warm done · ${res.ok} ok · ${res.failed} failed · ${(res.bytes / 1e9).toFixed(2)} GB`);
    return;
  }
  const dates = await archiveDates({ source: "manifest" });
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates.splice(o.max);
  const hourAllow = o.hours && o.hours.length ? new Set(o.hours) : undefined;
  console.log(
    `reversal PA-gate study · ${dates.length} sessions · session ${o.session.toUpperCase()} · split ${o.split} · stop ${o.stop}pt · slip ${o.slip}pt · cost ${COST_PTS}pt · hold ${HOLD_BARS} bars${hourAllow ? ` · hours [${[...hourAllow].sort((a, b) => a - b).join(",")}]` : ""}`,
  );

  const t0 = Date.now();
  const allA: RawSig[] = [];
  const allB: RawSig[] = [];
  const sessionBars = new Map<string, { high: number; low: number }[]>();
  const paTally = { same: 0, neutral: 0, opposite: 0 };
  let gateBOk = 0;
  let gateAOk = 0;
  let filteredA = 0;
  let filteredB = 0;
  let bars = 0;
  let loaded = 0;
  const prior: DayContext[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const eth = await loadSessionMinutes(date);
    if (!eth || eth.length < 60) {
      console.log(`  ${date}: no session data — skipped`);
      continue;
    }
    const fpEth = eth.map(toFootprint);
    const fpSess = o.session === "eth" ? fpEth : rthSlice(eth).map(toFootprint);
    sessionBars.set(date, fpSess.map((m) => ({ high: m.high, low: m.low })));
    if (fpSess.length < START_BAR + 30) {
      console.log(`  ${date}: ${o.session.toUpperCase()} slice too thin (${fpSess.length} bars) — skipped`);
      prior.push({ date, fpRth: rthSlice(eth).map(toFootprint), fpEth });
      continue;
    }
    const staticCtx = buildStaticContext(prior);
    const res = replaySession(fpSess, staticCtx, date, hourAllow);
    prior.push({ date, fpRth: rthSlice(eth).map(toFootprint), fpEth });
    if (prior.length > 6) prior.shift();
    loaded++;
    bars += res.bars;
    allA.push(...res.sigA);
    allB.push(...res.sigB);
    paTally.same += res.gateBPa.same;
    paTally.neutral += res.gateBPa.neutral;
    paTally.opposite += res.gateBPa.opposite;
    gateBOk += res.gateBOk;
    gateAOk += res.gateAOk;
    filteredA += res.filteredA;
    filteredB += res.filteredB;
    if (loaded % 100 === 0) console.log(`  ${loaded}/${dates.length} sessions · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`\nreplay done in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions · ${bars} bars`);

  /* ---- gate selectivity: what the PA vote does at OF-gate-ok bars ---- */
  const tot = paTally.same + paTally.neutral + paTally.opposite;
  console.log("\nPA VOTE AT OF-GATE-OK BARS (before footprint filters):");
  console.log(`  gate B open: ${gateBOk} bars · gate A open: ${gateAOk} bars · A blocked by PA: ${gateBOk - gateAOk} bars`);
  console.log(
    `  PA same: ${paTally.same} (${tot ? ((paTally.same / tot) * 100).toFixed(1) : 0}%) · neutral: ${paTally.neutral} (${tot ? ((paTally.neutral / tot) * 100).toFixed(1) : 0}%) · opposite: ${paTally.opposite} (${tot ? ((paTally.opposite / tot) * 100).toFixed(1) : 0}%)`,
  );
  console.log(`  footprint filters: A dropped ${filteredA} gate-ok bars · B dropped ${filteredB}`);

  /* ---- arm stats (raw episodes before the one-trade overlay) ---- */
  const mapA = new Map<string, RawSig>();
  for (const s of allA) if (!mapA.has(s.key)) mapA.set(s.key, s);
  const addedOnly = allB.filter((s) => !mapA.has(s.key));
  const sharedKeys = new Set(allB.filter((s) => mapA.has(s.key)).map((s) => s.key));
  const timingDeltas: number[] = [];
  for (const key of sharedKeys) {
    const a = mapA.get(key)!;
    const b = allB.find((s) => s.key === key)!;
    timingDeltas.push(b.entryIdx - a.entryIdx);
  }
  console.log(`\nEPISODES fired: A=${allA.length} · B=${allB.length} · shared=${sharedKeys.size} · added-only=${addedOnly.length}`);
  if (timingDeltas.length) {
    const avg = timingDeltas.reduce((x, y) => x + y, 0) / timingDeltas.length;
    const earlier = timingDeltas.filter((d) => d < 0).length;
    console.log(`  shared episodes: B fires ${avg.toFixed(1)} bars vs A on average (earlier: ${earlier}/${timingDeltas.length}, same bar: ${timingDeltas.filter((d) => d === 0).length}, later: ${timingDeltas.filter((d) => d > 0).length})`);
  }
  const bNeutral = allB.filter((s) => s.paVote === "neutral");
  const bOpp = allB.filter((s) => s.paVote === "opposite");
  console.log(`  B breakdown: same=${allB.length - bNeutral.length - bOpp.length} · PA-neutral=${bNeutral.length} · PA-opposite=${bOpp.length}`);

  const A = scoreArm(allA, sessionBars, { stop: o.stop, slip: o.slip });
  const B = scoreArm(allB, sessionBars, { stop: o.stop, slip: o.slip });
  const BN = scoreArm(bNeutral, sessionBars, { stop: o.stop, slip: o.slip });
  const BO = scoreArm(bOpp, sessionBars, { stop: o.stop, slip: o.slip });
  const ADD = scoreArm(addedOnly, sessionBars, { stop: o.stop, slip: o.slip });
  console.log(`scored trades: A=${A.scored} · B=${B.scored} · B∩neutral=${BN.scored} · B∩opposite=${BO.scored} · added-only=${ADD.scored}`);

  const split = o.split;
  const arm = (label: string, trades: EngineTrade[]) => ({
    label,
    all: coreStats(trades),
    train: coreStats(trades.filter((t) => t.date < split)),
    test: coreStats(trades.filter((t) => t.date >= split)),
  });

  const rows = [
    arm("A · PA gate (current)", A.trades),
    arm("B · OF-only gate (proposed)", B.trades),
    arm("B∩ · PA neutral (added)", BN.trades),
    arm("B∩ · PA opposite (added)", BO.trades),
    arm("B∖A · new episodes only", ADD.trades),
  ];
  console.log("\n=== ARM SUMMARY ===");
  for (const r of rows) {
    console.log(`${r.label.padEnd(28)} | ALL  ${fmtStats(r.all)}`);
    console.log(`${"".padEnd(28)} | TRAIN ${fmtStats(r.train)}`);
    console.log(`${"".padEnd(28)} | TEST  ${fmtStats(r.test)}`);
  }

  /* ---- standard report for both gate arms ---- */
  for (const [name, trades] of [
    ["A · PA gate (current)", A.trades],
    ["B · OF-only gate (proposed)", B.trades],
  ] as [string, EngineTrade[]][]) {
    console.log(`\n=== STANDARD REPORT — ${name} ===`);
    console.log(
      renderT0({
        "Instrument / session": "NQ 1-min · RTH (09:30–16:00 ET)",
        Sample: `${dates.length} sessions · ${trades.length} scored trades`,
        "Cost model": "0.5 pt round-trip",
        "Fill model": "market-entry replay (bar midpoint) · pessimistic same-bar exit · stop-first",
        "Exit model": "nearest POC target / 7-pt scalp stop / 60-bar time exit",
        Split: `70/30 by date (train < ${split} ≤ test)`,
        Significance: "Wilson 95% CI on WR",
        CLI: "web/scripts/reversalGateStudy.ts",
      }),
    );
    console.log(
      renderT1([
        { label: "all", stats: coreStats(trades) },
        { label: "train", stats: coreStats(trades.filter((t) => t.date < split)) },
        { label: "test", stats: coreStats(trades.filter((t) => t.date >= split)) },
      ]),
    );
    console.log(
      renderT2(
        rows.map((r) => ({
          rule: r.label,
          n: r.test.n,
          wr: r.test.wr,
          ci: wilson95(r.test.wins, r.test.n),
          pf: r.test.pf,
          expPts: r.test.expPts,
          trainTest: `${r.train.wr.toFixed(0)}% / ${r.test.wr.toFixed(0)}%`,
        })),
      ),
    );
    const viability = propViability(trades, { splitDate: split });
    console.log(renderT4(viability));
    console.log(
      renderVerdict({
        edge: coreStats(trades.filter((t) => t.date >= split)).expPts > 0 ? "real" : "absent",
        significance: "—",
        stability: (() => {
          const tr = coreStats(trades.filter((t) => t.date < split));
          const te = coreStats(trades.filter((t) => t.date >= split));
          return `train/test WR ${tr.wr.toFixed(1)}/${te.wr.toFixed(1)}`;
        })(),
        holdout: "n/a",
        viability: viability.pPass === null ? "n/a" : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
    );
  }

  /* ---- stability by year ---- */
  console.log("\n=== BY YEAR ===");
  for (const [name, trades] of [
    ["A", A.trades],
    ["B", B.trades],
  ] as [string, EngineTrade[]][]) {
    const yrs = byYear(trades).map((y) => `${y.year}: n=${y.stats.n} wr=${y.stats.wr.toFixed(0)}% exp=${y.stats.expPts.toFixed(2)}`);
    console.log(`  ${name}: ${yrs.join(" · ")}`);
  }

  /* ---- edge by hour (feed clock; ET ≈ +1h) — where the volume pays ---- */
  const hourTable = (label: string, trades: EngineTrade[], hours: number[]) => {
    const buckets = new Map<number, EngineTrade[]>();
    trades.forEach((t, i) => {
      const h = hours[i] ?? -1;
      const a = buckets.get(h);
      if (a) a.push(t);
      else buckets.set(h, [t]);
    });
    console.log(`\n=== BY HOUR (${label} · arm A · feed-clock hour) ===`);
    for (const [h, tr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const st = coreStats(tr);
      console.log(`  ${String(h).padStart(2, "0")}:00 · n=${String(st.n).padStart(4)} wr=${st.wr.toFixed(0).padStart(3)}% exp=${st.expPts >= 0 ? "+" : ""}${st.expPts.toFixed(2)}pts`);
    }
  };
  hourTable(o.byhourTrain ? "train-only" : "all", o.byhourTrain ? A.trades.filter((t) => t.date < split) : A.trades, o.byhourTrain ? A.hours.filter((_, i) => A.trades[i].date < split) : A.hours);

  /* ---- stop/slip sensitivity grid over the SAME signals (arm A) ---- */
  if (o.slipSweep) {
    const grid = [
      { stop: 7, slip: 0 },
      { stop: 7, slip: 0.25 },
      { stop: 7, slip: 0.5 },
      { stop: 5, slip: 0 },
      { stop: 5, slip: 0.25 },
      { stop: 5, slip: 0.5 },
      { stop: 5, slip: 1 },
    ];
    console.log("\n=== STOP/SLIP SWEEP (arm A · identical signals · per-cell sequential overlay) ===");
    console.log("stop slip | ALL  n  WR   PF  expPts expR maxDD | TEST n  WR   PF  expPts expR | P(pass)");
    for (const c of grid) {
      const r = scoreArm(allA, sessionBars, c);
      const all = coreStats(r.trades);
      const test = coreStats(r.trades.filter((t) => t.date >= split));
      const viab = propViability(r.trades, { splitDate: split });
      const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : " — ");
      console.log(
        `${c.stop}  ${c.slip.toFixed(2)} | ALL ${String(all.n).padStart(4)} ${String(all.wr.toFixed(0)).padStart(3)}% ${pf(all.pf).padStart(5)} ${all.expPts >= 0 ? "+" : ""}${all.expPts.toFixed(2).padStart(5)} ${all.expR >= 0 ? "+" : ""}${all.expR.toFixed(2)} ${String(Math.round(all.maxDdPts)).padStart(4)} | TEST ${String(test.n).padStart(4)} ${String(test.wr.toFixed(0)).padStart(3)}% ${pf(test.pf).padStart(5)} ${test.expPts >= 0 ? "+" : ""}${test.expPts.toFixed(2).padStart(5)} ${test.expR >= 0 ? "+" : ""}${test.expR.toFixed(2)} | ${viab.pPass === null ? "n/a" : (viab.pPass * 100).toFixed(0) + "%"}`,
      );
    }
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          split,
          costPts: COST_PTS,
          holdBars: HOLD_BARS,
          stopPts: STOP_PTS,
          sessions: loaded,
          arms: {
            A: { trades: A.trades, stats: arm("A", A.trades) },
            B: { trades: B.trades, stats: arm("B", B.trades) },
            BNeutral: { trades: BN.trades, stats: arm("BN", BN.trades) },
            BOpposite: { trades: BO.trades, stats: arm("BO", BO.trades) },
            AddedOnly: { trades: ADD.trades, stats: arm("ADD", ADD.trades) },
          },
          episodes: { A: allA.length, B: allB.length, shared: sharedKeys.size, addedOnly: addedOnly.length, timingDeltas },
          gateTally: { gateBOk, gateAOk, paTally, filteredA, filteredB },
        },
        null,
        1,
      ),
    );
    console.log(`\ndump → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
