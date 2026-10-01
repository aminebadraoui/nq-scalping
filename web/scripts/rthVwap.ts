/* ------------------------------------------------------------------ *
 * RTH VWAP study — VWAP-anchored scalp structures for NQ futures,
 * restricted to the 9:30-16:00 New York session, grounded in the
 * MyFundedFutures Rapid EOD 50k plan.
 *
 * Session VWAP is computed incrementally over RTH bars only, using the
 * typical price (high+low+close)/3 weighted by volume (buy+sell), so it
 * anchors to the cash session instead of the overnight drift. ATR14 is
 * the median of the trailing 14 bar ranges (house convention). Delta is
 * the trailing N-bar cumulative buy-sell, excluding the current bar.
 *
 * Variant family:
 *   A  VWAP PULLBACK CONTINUATION — price closes 0.25-1.0xATR beyond VWAP,
 *      the bar dips toward VWAP (low/high within dipTol of it), prints
 *      trade-side delta with buy/sell-frac >= th → enter at close, stop
 *      under/over the dip bar -/+ 0.5, 1R target, risk <= 12.
 *   B  VWAP EXTENSION FADE — close >= ext*ATR beyond VWAP while trailing
 *      delta runs against the extension → fade back to VWAP (or 1R if
 *      closer); stop beyond the bar +/- 0.5, risk <= 15.
 *   C  VWAP CROSS + ABSORPTION — a bar crosses and closes beyond VWAP,
 *      then within probeBars a counter-delta bar probes back toward VWAP
 *      but closes back on the cross side (failed re-cross) → enter at
 *      that close, stop under the probe, 1R, risk <= 15.
 *   D  A + TREND FILTER — only take A when the trailing 30-bar delta
 *      agrees with the trade side.
 *   I  FOOTPRINT × CANDLE IMPACT — RTH bars within 1.5xATR of VWAP are
 *      bucketed by (dominant footprint cluster: rows >= 3 lots with
 *      >= 2:1 imbalance) x (delta share) x (range/ATR); next-bar
 *      directional accuracy per cell; the top cells (n >= 300, highest
 *      accuracy) become 1R variants entered at the close in the cluster
 *      direction.
 *
 * Scoring (first-touch, pessimistic, identical for every variant):
 * walk bars k+1..k+60 (bounded by the RTH close); stop first → loss
 * (-risk-0.5), target first → win (+distToTarget-0.5), neither →
 * excluded from WR and counted as 0 in expectancy. 0.5 pt cost each way.
 *
 * Usage:
 *   GC_REMOTE_URL=https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev \
 *     node --import ../scripts/ts-loader.mjs scripts/rthVwap.ts
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { closeOf, type MomMinute } from "../lib/momentum";

/* ------------------------------ constants ------------------------------ */

const COST = 0.5; // points per side
const WINDOW = 60; // exit walk, bars
const MIN_BARS_LEFT = 5; // entry must have RTH room to resolve
const SPACING = 5; // min bars between entries per variant
const MIN_ANCHOR = 30; // RTH bars before VWAP is "anchored" enough to trade
const RISK_CAP_A = 12; // A / D / I risk cap (pts)
const RISK_CAP_OTHER = 15; // B / C risk cap (pts)

const NEAR_VWAP_ATR = 1.5; // "near a VWAP structure" gate for footprint cells
const CELL_MIN_N = 300; // min cell bars to build a variant
const MAX_CELLS = 12; // interaction variants to build, by accuracy

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
const inRTH = (t: string): boolean => {
  const h = hourET(t);
  const mm = mmOf(t);
  return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

const med = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/* -------------------------------- types -------------------------------- */

type Dir = 1 | -1;
type Outcome = "win" | "loss" | "timeout";

type Trade = {
  date: string;
  year: number;
  time: string; // feed clock (Central)
  dir: Dir;
  entry: number;
  stop: number;
  target: number;
  risk: number; // pts to stop
  distTp: number; // pts to target
  pnl: number; // net pts, cost included, 0 for timeouts
  outcome: Outcome;
  bars: number; // bars to resolution (-1 for timeout)
  vwap: number;
  atr: number;
  d30: number;
  d15: number;
  frac: number; // trade-side volume fraction
  vol: number;
};

type Scored = {
  name: string;
  n: number; // resolved entries (WR denominator)
  wins: number;
  losses: number;
  to: number; // timeouts (excluded from WR, 0 in expectancy)
  grossWin: number;
  grossLoss: number;
  net: number;
  trades: Trade[];
};

type Signal = { dir: Dir; entry: number; stop: number; target: number } | null;

type Ctx = {
  close: number;
  high: number;
  low: number;
  vwap: number;
  atr: number;
  d30: number;
  d15: number;
  fracB: number; // buy / total volume
  vol: number;
  mv: number; // median volume of trailing 60 bars
};

type CrossState = { up: number; dn: number };
type Pred = (k: number, m: MomMinute, ctx: Ctx) => Signal;

type CProbe = { p: number; tol: number };
type CellDef = { side: "B" | "S"; count: 1 | 2 | 3; ds: string; r: string };
type VariantDef = {
  name: string;
  pred?: Pred;
  gate?: (ctx: Ctx, dir: Dir) => boolean;
  cprobe?: CProbe;
  cell?: CellDef;
};

/* --------------------------- variant predicates --------------------------- */

function variantA(fracTh: number, volMult: number, dipTol: number): Pred {
  return (k, m, ctx) => {
    void k;
    if (volMult > 0 && ctx.vol < volMult * ctx.mv) return null;
    const bandLo = 0.25 * ctx.atr;
    const bandHi = 1.0 * ctx.atr;
    const dip = dipTol * ctx.atr;
    // long: close above VWAP inside the band, bar dips toward it, buy-side
    const distL = ctx.close - ctx.vwap;
    if (distL >= bandLo && distL <= bandHi && ctx.low >= ctx.vwap - dip && ctx.low <= ctx.vwap + dip) {
      if (m.buy > m.sell && ctx.fracB >= fracTh) {
        const entry = ctx.close;
        const stop = ctx.low - 0.5;
        const risk = entry - stop;
        if (risk > 0 && risk <= RISK_CAP_A) return { dir: 1, entry, stop, target: entry + risk };
      }
    }
    // short mirror
    const distS = ctx.vwap - ctx.close;
    if (distS >= bandLo && distS <= bandHi && ctx.high <= ctx.vwap + dip && ctx.high >= ctx.vwap - dip) {
      if (m.sell > m.buy && 1 - ctx.fracB >= fracTh) {
        const entry = ctx.close;
        const stop = ctx.high + 0.5;
        const risk = stop - entry;
        if (risk > 0 && risk <= RISK_CAP_A) return { dir: -1, entry, stop, target: entry - risk };
      }
    }
    return null;
  };
}

function variantB(ext: number, win: number): Pred {
  return (k, m, ctx) => {
    void k;
    void m;
    const delta = win === 15 ? ctx.d15 : ctx.d30;
    // short: stretched above VWAP while flow is against the extension
    if (ctx.close >= ctx.vwap + ext * ctx.atr && delta < 0) {
      const entry = ctx.close;
      const stop = ctx.high + 0.5;
      const risk = stop - entry;
      if (risk > 0 && risk <= RISK_CAP_OTHER) {
        const distTp = Math.min(ctx.close - ctx.vwap, risk);
        return { dir: -1, entry, stop, target: entry - distTp };
      }
    }
    // long mirror: stretched below VWAP, positive delta
    if (ctx.close <= ctx.vwap - ext * ctx.atr && delta > 0) {
      const entry = ctx.close;
      const stop = ctx.low - 0.5;
      const risk = entry - stop;
      if (risk > 0 && risk <= RISK_CAP_OTHER) {
        const distTp = Math.min(ctx.vwap - ctx.close, risk);
        return { dir: 1, entry, stop, target: entry + distTp };
      }
    }
    return null;
  };
}

function cProbe(cp: CProbe, k: number, m: MomMinute, ctx: Ctx, cross: CrossState): Signal {
  const dip = cp.tol * ctx.atr;
  // long: an up-cross within probeBars, then a sell bar probes toward VWAP
  if (cross.up >= 0 && k > cross.up && k - cross.up <= cp.p) {
    if (m.sell > m.buy && ctx.low <= ctx.vwap + dip && ctx.low >= ctx.vwap - dip && ctx.close > ctx.vwap) {
      const entry = ctx.close;
      const stop = ctx.low - 0.5;
      const risk = entry - stop;
      if (risk > 0 && risk <= RISK_CAP_OTHER) return { dir: 1, entry, stop, target: entry + risk };
    }
  }
  // short mirror
  if (cross.dn >= 0 && k > cross.dn && k - cross.dn <= cp.p) {
    if (m.buy > m.sell && ctx.high >= ctx.vwap - dip && ctx.high <= ctx.vwap + dip && ctx.close < ctx.vwap) {
      const entry = ctx.close;
      const stop = ctx.high + 0.5;
      const risk = stop - entry;
      if (risk > 0 && risk <= RISK_CAP_OTHER) return { dir: -1, entry, stop, target: entry - risk };
    }
  }
  return null;
}

/* ------------------------- footprint interaction ------------------------- */

/** dominant footprint cluster: rows with >= 3 lots and >= 2:1 buy/sell
 *  imbalance; the side with more such rows wins, ties are neutral. */
function dominantCluster(m: MomMinute): { side: "B" | "S" | null; count: number } {
  let b = 0;
  let s = 0;
  for (const l of m.levels) {
    if (l.buy + l.sell < 3) continue;
    if (l.buy >= 2 * l.sell) b++;
    else if (l.sell >= 2 * l.buy) s++;
  }
  if (b === s) return { side: null, count: 0 };
  return b > s ? { side: "B", count: b } : { side: "S", count: s };
}

const countB = (c: number): 1 | 2 | 3 => (c >= 3 ? 3 : (c as 1 | 2 | 3));
const dsB = (share: number): string => (share > 0.3 ? "ds++" : share >= 0 ? "ds+" : share >= -0.3 ? "ds-" : "ds--");
const rB = (rr: number): string => (rr < 0.5 ? "r05" : rr <= 1 ? "r1" : "r1p");

function cellKey(c: CellDef): string {
  return `${c.side}${c.count}-${c.ds}-${c.r}`;
}
function cellName(c: CellDef): string {
  return `i-${cellKey(c)}`;
}

type Bucket = { n: number; hits: number };

function bucketOf(k: number, m: MomMinute, ctx: Ctx): CellDef | null {
  void k;
  if (Math.abs(ctx.close - ctx.vwap) > NEAR_VWAP_ATR * ctx.atr) return null;
  const dom = dominantCluster(m);
  if (!dom.side) return null;
  const vol = m.buy + m.sell;
  const share = vol > 0 ? (m.buy - m.sell) / vol : 0;
  return {
    side: dom.side,
    count: countB(dom.count),
    ds: dsB(share),
    r: rB((m.high - m.low) / ctx.atr),
  };
}

function cellPred(c: CellDef): Pred {
  return (k, m, ctx) => {
    void k;
    if (Math.abs(ctx.close - ctx.vwap) > NEAR_VWAP_ATR * ctx.atr) return null;
    const dom = dominantCluster(m);
    if (!dom.side || dom.side !== c.side || countB(dom.count) !== c.count) return null;
    const vol = m.buy + m.sell;
    const share = vol > 0 ? (m.buy - m.sell) / vol : 0;
    if (dsB(share) !== c.ds) return null;
    if (rB((m.high - m.low) / ctx.atr) !== c.r) return null;
    if (c.side === "B") {
      const entry = ctx.close;
      const stop = ctx.low - 0.5;
      const risk = entry - stop;
      if (risk > 0 && risk <= RISK_CAP_A) return { dir: 1, entry, stop, target: entry + risk };
    }
    const entry = ctx.close;
    const stop = ctx.high + 0.5;
    const risk = stop - entry;
    if (risk > 0 && risk <= RISK_CAP_A) return { dir: -1, entry, stop, target: entry - risk };
  };
}

/* ------------------------------ scan + score ------------------------------ */

type ScanFn = (
  k: number,
  m: MomMinute,
  ctx: Ctx,
  prev: Ctx | null,
  cross: CrossState,
  lastRth: number,
  minutes: MomMinute[],
) => void;

async function scanSessions(fn: ScanFn): Promise<number> {
  const dates = await archiveDates();
  let sessions = 0;
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    sessions++;
    const n = minutes.length;

    const cum = new Array<number>(n).fill(0);
    let c = 0;
    for (let i = 0; i < n; i++) {
      c += minutes[i].buy - minutes[i].sell;
      cum[i] = c;
    }

    const vwapArr = new Array<number>(n).fill(NaN);
    const rthArr = new Array<number>(n).fill(0);
    let rc = 0;
    let tv = 0;
    let tp = 0;
    let lastRth = -1;
    for (let i = 0; i < n; i++) {
      if (inRTH(minutes[i].t)) {
        rc++;
        lastRth = i;
        const m = minutes[i];
        const v = m.buy + m.sell;
        if (v > 0) {
          tp += ((m.high + m.low + closeOf(m)) / 3) * v;
          tv += v;
        }
        vwapArr[i] = tv > 0 ? tp / tv : NaN;
      }
      rthArr[i] = rc;
    }

    const atrArr = new Array<number>(n).fill(0);
    const mvArr = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const r: number[] = [];
      const v: number[] = [];
      for (let j = Math.max(0, i - 14); j < i; j++) r.push(minutes[j].high - minutes[j].low);
      for (let j = Math.max(0, i - 60); j < i; j++) v.push(minutes[j].buy + minutes[j].sell);
      atrArr[i] = med(r);
      mvArr[i] = med(v);
    }

    const ctxOf = (i: number): Ctx => {
      const m = minutes[i];
      const vol = m.buy + m.sell;
      const dN = (w: number) => (i - w >= 0 ? cum[i - 1] - (i - 1 - w >= 0 ? cum[i - 1 - w] : 0) : cum[i - 1]);
      return {
        close: closeOf(m),
        high: m.high,
        low: m.low,
        vwap: vwapArr[i],
        atr: atrArr[i],
        d30: dN(30),
        d15: dN(15),
        fracB: vol > 0 ? m.buy / vol : 0.5,
        vol,
        mv: mvArr[i],
      };
    };

    let up = -1;
    let dn = -1;
    for (let k = 1; k < n; k++) {
      if (rthArr[k] < MIN_ANCHOR) continue;
      if (!inRTH(minutes[k].t)) continue;
      if (k > lastRth - MIN_BARS_LEFT) continue;
      const ctx = ctxOf(k);
      if (!Number.isFinite(ctx.vwap) || ctx.atr <= 0) continue;
      const prev = inRTH(minutes[k - 1].t) ? ctxOf(k - 1) : null;
      if (prev && Number.isFinite(prev.vwap)) {
        if (prev.close < prev.vwap && ctx.close > ctx.vwap) up = k;
        if (prev.close > prev.vwap && ctx.close < ctx.vwap) dn = k;
      }
      fn(k, minutes[k], ctx, prev, { up, dn }, lastRth, minutes);
    }
  }
  return sessions;
}

function freshScored(name: string): Scored {
  return { name, n: 0, wins: 0, losses: 0, to: 0, grossWin: 0, grossLoss: 0, net: 0, trades: [] };
}

/** one pass over all sessions: score every variant def and (optionally)
 *  accumulate footprint × candle-impact buckets. */
async function evaluate(
  defs: VariantDef[],
  buckets: Map<string, Bucket> | null,
): Promise<Map<string, Scored>> {
  const agg = new Map<string, Scored>();
  for (const d of defs) agg.set(d.name, freshScored(d.name));
  const lastIdx = new Map<string, number>();
  for (const d of defs) lastIdx.set(d.name, -SPACING);

  const sessions = await scanSessions((k, m, ctx, _prev, cross, lastRth, minutes) => {
    if (buckets && k + 1 <= lastRth) {
      const cell = bucketOf(k, m, ctx);
      if (cell) {
        const key = cellKey(cell);
        const b = buckets.get(key) ?? { n: 0, hits: 0 };
        b.n++;
        const nxt = closeOf(minutes[k + 1]);
        const up = cell.side === "B" ? nxt > ctx.close : nxt < ctx.close;
        if (up) b.hits++;
        buckets.set(key, b);
      }
    }
    for (const d of defs) {
      if (k - (lastIdx.get(d.name) ?? -1e9) < SPACING) continue;
      let sig: Signal = null;
      if (d.cprobe) sig = cProbe(d.cprobe, k, m, ctx, cross);
      else if (d.pred) sig = d.pred(k, m, ctx);
      if (!sig) continue;
      if (d.gate && !d.gate(ctx, sig.dir)) continue;

      const a = agg.get(d.name)!;
      const { dir, entry, stop, target } = sig;
      const risk = Math.abs(entry - stop);
      const distTp = Math.abs(target - entry);
      if (!(risk > 0 && distTp > 0)) continue;

      // first-touch, pessimistic: the stop wins ties on the same bar
      const end = Math.min(k + WINDOW, lastRth);
      let outcome: Outcome = "timeout";
      let bars = -1;
      for (let j = k + 1; j <= end; j++) {
        const b = minutes[j];
        if (dir === 1 ? b.low <= stop : b.high >= stop) {
          outcome = "loss";
          bars = j - k;
          break;
        }
        if (dir === 1 ? b.high >= target : b.low <= target) {
          outcome = "win";
          bars = j - k;
          break;
        }
      }
      const pnl = outcome === "win" ? distTp - COST : outcome === "loss" ? -risk - COST : 0;
      a.n += outcome === "timeout" ? 0 : 1;
      if (outcome === "win") {
        a.wins++;
        a.grossWin += distTp;
      } else if (outcome === "loss") {
        a.losses++;
        a.grossLoss += risk;
      } else {
        a.to++;
      }
      a.net += pnl;
      a.trades.push({
        date: m.d,
        year: Number(m.d.slice(0, 4)),
        time: m.t,
        dir,
        entry,
        stop,
        target,
        risk,
        distTp,
        pnl,
        outcome,
        bars,
        vwap: ctx.vwap,
        atr: ctx.atr,
        d30: ctx.d30,
        d15: ctx.d15,
        frac: dir === 1 ? ctx.fracB : 1 - ctx.fracB,
        vol: ctx.vol,
      });
      lastIdx.set(d.name, k);
    }
  });
  void sessions;
  return agg;
}

/* -------------------------------- output -------------------------------- */

const wrOf = (s: Scored): number => (s.n ? (100 * s.wins) / s.n : 0);
const expOf = (s: Scored): number => {
  const all = s.n + s.to;
  return all ? s.net / all : 0;
};
const pfOf = (s: Scored): number =>
  s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? Infinity : 0;

function pickBest(all: Map<string, Scored>): Scored {
  const list = [...all.values()];
  const q = list
    .filter((s) => s.n >= 30 && wrOf(s) >= 75)
    .sort((a, b) => b.n - a.n || expOf(b) - expOf(a));
  if (q.length) return q[0];
  const fallback = list.filter((s) => s.n >= 30);
  if (fallback.length) {
    return [...fallback].sort(
      (a, b) => Math.abs(wrOf(a) - 75) - Math.abs(wrOf(b) - 75) || b.n - a.n,
    )[0];
  }
  return list.sort((a, b) => b.n - a.n)[0];
}

async function main() {
  const t0 = Date.now();

  /* ---- round grid (edit between rounds) ---- */
  const defs: VariantDef[] = [];
  for (const th of [0.5, 0.55, 0.6]) for (const v of [0, 0.5]) {
    defs.push({ name: `a-f${th}-v${v}`, pred: variantA(th, v, 0.25) });
    defs.push({
      name: `d-f${th}-v${v}`,
      pred: variantA(th, v, 0.25),
      gate: (ctx, dir) => (dir === 1 ? ctx.d30 > 0 : ctx.d30 < 0),
    });
  }
  for (const e of [1.5, 2.0]) for (const w of [15, 30]) defs.push({ name: `b-e${e}-w${w}`, pred: variantB(e, w) });
  for (const p of [2, 3]) for (const tol of [0.25, 0.5]) defs.push({ name: `c-p${p}-t${tol}`, cprobe: { p, tol } });

  console.log("RTH VWAP study — pass 1: A/B/C/D variants + footprint interaction buckets…");
  const buckets = new Map<string, Bucket>();
  const agg1 = await evaluate(defs, buckets);
  const s1 = Date.now();
  console.log(`pass 1 done in ${((s1 - t0) / 1000).toFixed(0)}s`);

  /* ---- interaction table + cell-derived 1R variants ---- */
  const cells = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\nFOOTPRINT × CANDLE INTERACTION (bars within ${NEAR_VWAP_ATR}xATR of VWAP, next-bar accuracy):`);
  console.log("cell          | n      | acc%   | qual");
  const qual = cells.filter(([, b]) => b.n >= CELL_MIN_N && (100 * b.hits) / b.n >= 75);
  for (const [key, b] of cells) {
    const acc = (100 * b.hits) / b.n;
    const ok = b.n >= CELL_MIN_N && acc >= 75;
    console.log(
      `${key.padEnd(13)} | ${String(b.n).padStart(6)} | ${acc.toFixed(1).padStart(5)} | ${ok ? ">=75% n>=300" : ""}`,
    );
  }
  console.log(`cells qualifying (n>=${CELL_MIN_N}, acc>=75%): ${qual.length}`);

  const topCells: CellDef[] = [];
  for (const [key, b] of cells) {
    if (b.n < CELL_MIN_N) continue;
    const [sideCount, ds, r] = key.split("-");
    const side = sideCount.startsWith("B") ? "B" : "S";
    const count = Number(sideCount.slice(1)) as 1 | 2 | 3;
    topCells.push({ side, count, ds, r });
    if (topCells.length >= MAX_CELLS) break;
  }
  const cellDefs: VariantDef[] = topCells.map((c) => ({ name: cellName(c), cell: c, pred: cellPred(c) }));
  console.log(`building 1R variants from top ${cellDefs.length} cells (by n, n>=${CELL_MIN_N})…\n`);

  const agg2 = cellDefs.length ? await evaluate(cellDefs, null) : new Map<string, Scored>();
  const all = new Map<string, Scored>([...agg1, ...agg2]);

  /* ---- variant table ---- */
  console.log("VARIANT TABLE (first-touch 60-bar walk, 0.5pt cost; n = resolved):");
  console.log("name           | n     | wins  | loss  | to    | WR%    | PF     | net pts | exp/trade");
  const rows = [...all.values()].sort((a, b) => b.n - a.n);
  for (const s of rows) {
    console.log(
      `${s.name.padEnd(14)} | ${String(s.n).padStart(5)} | ${String(s.wins).padStart(5)} | ${String(s.losses).padStart(5)} | ${String(s.to).padStart(5)} | ${wrOf(s).toFixed(1).padStart(6)} | ${(Number.isFinite(pfOf(s)) ? pfOf(s).toFixed(2) : "inf").padStart(6)} | ${s.net.toFixed(0).padStart(7)} | ${expOf(s).toFixed(3).padStart(9)}`,
    );
  }

  /* ---- best config ---- */
  const best = pickBest(all);
  const qualCount = qual.length;
  console.log(`\nBEST >=75% CONFIG: ${best.name}  (qualifying cells: ${qualCount})`);
  console.log(`  n=${best.n} (${best.to} timeouts)  WR=${wrOf(best).toFixed(1)}%  PF=${Number.isFinite(pfOf(best)) ? pfOf(best).toFixed(2) : "inf"}  net=${best.net.toFixed(1)} pts  exp=${expOf(best).toFixed(3)} pts/trade`);

  const longs = best.trades.filter((t) => t.dir === 1);
  const shorts = best.trades.filter((t) => t.dir === -1);
  const sideLine = (xs: Trade[], label: string) =>
    `  ${label}: n=${xs.filter((t) => t.outcome !== "timeout").length} WR=${xs.filter((t) => t.outcome !== "timeout").length ? ((100 * xs.filter((t) => t.outcome === "win").length) / xs.filter((t) => t.outcome !== "timeout").length).toFixed(1) : "n/a"}% net=${xs.reduce((a, t) => a + t.pnl, 0).toFixed(1)}`;
  if (longs.length) console.log(sideLine(longs, "LONG"));
  if (shorts.length) console.log(sideLine(shorts, "SHORT"));

  /* ---- by-year ---- */
  const byYear = new Map<number, { n: number; wins: number; losses: number; to: number; net: number }>();
  for (const t of best.trades) {
    const y = byYear.get(t.year) ?? { n: 0, wins: 0, losses: 0, to: 0, net: 0 };
    if (t.outcome === "win") {
      y.wins++;
      y.n++;
    } else if (t.outcome === "loss") {
      y.losses++;
      y.n++;
    } else {
      y.to++;
    }
    y.net += t.pnl;
    byYear.set(t.year, y);
  }
  console.log("\nBY-YEAR (best config):");
  console.log("year | n    | WR%    | net pts");
  for (const [y, s] of [...byYear.entries()].sort()) {
    console.log(`${y} | ${String(s.n).padStart(4)} | ${(s.n ? (100 * s.wins) / s.n : 0).toFixed(1).padStart(6)} | ${s.net.toFixed(1).padStart(7)}`);
  }

  /* ---- MFF grounding ---- */
  const d9 = dollarize(best.trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
  console.log("\nACCOUNT (Rapid EOD 50k, budget-sized MNQ):");
  console.log("  eval  ", accountLine(simulateAccount(d9, "eval")));
  console.log("  funded", accountLine(simulateAccount(d9, "funded")));
  const ev = simulateAccount(d9, "eval");
  const fu = simulateAccount(d9, "funded");
  console.log(
    `  eval detail: breach=${ev.breachDay ?? "none"} · tradingDays=${ev.tradingDays} · bestDay=$${ev.bestDay.toFixed(0)} · totalProfit=$${ev.totalProfit.toFixed(0)} · consistency=${ev.consistencyOk ? "ok" : "FAIL"}`,
  );
  console.log(`  funded detail: breach=${fu.breachDay ?? "none"} · equity=$${fu.finalEquity.toFixed(0)} · payouts=${fu.payouts}`);
  console.log(`  net $ (budget-sized): ${d9.reduce((a, t) => a + t.pnl, 0).toFixed(0)}`);

  /* ---- JSON dump ---- */
  const dump = {
    tool: "rthVwap",
    generatedAt: new Date().toISOString(),
    scoring: "first-touch pessimistic, 60-bar walk bounded by RTH close, stop priority, 0.5pt cost, timeouts excluded from WR and 0 in expectancy",
    sessions: await archiveDates().then((d) => d.length),
    best: {
      name: best.name,
      n: best.n,
      wins: best.wins,
      losses: best.losses,
      timeouts: best.to,
      wr: Number(wrOf(best).toFixed(1)),
      pf: Number(Number.isFinite(pfOf(best)) ? pfOf(best).toFixed(2) : -1),
      netPts: Number(best.net.toFixed(1)),
      expPts: Number(expOf(best).toFixed(3)),
      byYear: [...byYear.entries()].map(([year, s]) => ({
        year,
        n: s.n,
        timeouts: s.to,
        wr: Number((s.n ? (100 * s.wins) / s.n : 0).toFixed(1)),
        netPts: Number(s.net.toFixed(1)),
      })),
    },
    interactionCells: cells
      .filter(([, b]) => b.n >= CELL_MIN_N)
      .map(([key, b]) => ({
        cell: key,
        n: b.n,
        accPct: Number(((100 * b.hits) / b.n).toFixed(1)),
        qualified: (100 * b.hits) / b.n >= 75,
      })),
    trades: best.trades.map((t) => ({
      date: t.date,
      year: t.year,
      time: t.time,
      dir: t.dir === 1 ? "L" : "S",
      entry: Number(t.entry.toFixed(2)),
      stop: Number(t.stop.toFixed(2)),
      target: Number(t.target.toFixed(2)),
      risk: Number(t.risk.toFixed(2)),
      pnl: Number(t.pnl.toFixed(2)),
      outcome: t.outcome,
      bars: t.bars,
      vwap: Number(t.vwap.toFixed(2)),
      atr: Number(t.atr.toFixed(2)),
      d30: t.d30,
      frac: Number(t.frac.toFixed(2)),
      vol: t.vol,
    })),
  };
  await fs.writeFile("/tmp/rth_vwap_trades.json", JSON.stringify(dump, null, 2));
  console.log(`\nwrote /tmp/rth_vwap_trades.json (${best.trades.length} trades) · total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
