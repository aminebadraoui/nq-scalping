/* ------------------------------------------------------------------ *
 * rthGateSweep.ts — RTH gate sweep: push the soft-momentum baseline
 * (69.4% long / 67.1% short at buy-frac ≥ 0.60, vol ≥ 0.5 × med60,
 * risk 3-15 pts, 1R target, 5-bar gap) toward WR ≥ 75% with
 * n ≥ 300 decided trades.
 *
 * Scoring (identical for every variant, first-touch, pessimistic):
 * after entry at bar k's close, walk bars k+1..k+60. Stop hit before
 * target → loss (-risk - 0.5); target first → win (+risk - 0.5);
 * neither → skip (out of WR, counted as 0 in expectancy). Same-bar
 * stop+target resolves as a stop. 0.5 pt round-trip cost.
 *
 * Footprint × candle-impact interaction pass (--cells / --auto-cells):
 * every RTH bar is bucketed by
 *   dominant-cluster side AND count (rows with ≥3 lots and ≥2:1)
 *   × delta share (0.5 / 0.6 / 0.7)
 *   × range ÷ ATR14 (0.8 / 1.2 / 1.6)
 * and each cell's next-bar directional accuracy is measured. With
 * --auto-cells the cells meeting n ≥ 300 and accuracy ≥ 75% are
 * turned into 1R strategy variants automatically.
 *
 * Grounding: every trade is sized and replayed through the
 * MyFundedFutures Rapid EOD 50k simulator (EOD-trailing $2,000 MLL,
 * $170 risk budget, 30-micro cap) — eval and funded lines printed
 * for every variant, with breaches and consistency reported.
 *
 *   GC_REMOTE_URL=https://… node --import ../scripts/ts-loader.mjs \
 *     scripts/rthGateSweep.ts [--round N] [--max N] [--sequential] \
 *     [--cells] [--auto-cells] [--dump /tmp/rth_gate_trades.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";
import { inRTH } from "../lib/softMomentum";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const MED_WINDOW = 60;
const MIN_DECIDED = 300; // the n gate: decided trades must stay ≥ this
const WR_TARGET = 75; // % target

/* ---------------- gate config ---------------- */

export type HourWin = "all" | "open" | "mid" | "pm";
export type GateDir = "both" | "long" | "short";

export type GateConfig = {
  /** one-sidedness: buy-frac ≥ minBuyFrac (mirror ≤ 1 - minBuyFrac) */
  minBuyFrac: number;
  /** volume floor × trailing 60-bar median volume */
  volMedMult: number;
  /** sign(bar delta) == sign(trailing trendBars-bar cumulative delta) */
  trendAgree: boolean;
  trendBars: number;
  /** bar POC (max-volume level) must sit in the trade-direction half */
  pocSide: boolean;
  /** 0 = off; bar range ≥ minRangeR × ATR14 (median prior-14 range) */
  minRangeR: number;
  hourWin: HourWin;
  /** require ≥ tickProofN dominant clusters (rows with side ≥
   *  tickProofLots lots and side ≥ tickProofRatio × opposite) */
  tickProof: boolean;
  tickProofN: number;
  tickProofLots: number;
  tickProofRatio: number;
  /** "half" = clusters on the trade-direction half of the bar (the
   *  sweep dimension), "whole" = clusters anywhere in the bar (the
   *  interaction-cell definition) */
  tickProofScope: "half" | "whole";
  dir: GateDir;
  stopPad: number;
  minRiskPts: number;
  maxRiskPts: number;
  targetR: number;
  minGapBars: number;
};

export const GATE_DEFAULTS: GateConfig = {
  minBuyFrac: 0.6,
  volMedMult: 0.5,
  trendAgree: false,
  trendBars: 15,
  pocSide: false,
  minRangeR: 0,
  hourWin: "all",
  tickProof: false,
  tickProofN: 2,
  tickProofLots: 3,
  tickProofRatio: 2,
  tickProofScope: "half",
  dir: "both",
  stopPad: 1.0,
  minRiskPts: 3,
  maxRiskPts: 15,
  targetR: 1,
  minGapBars: 5,
};

/* ---------------- helpers ---------------- */

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));

function inWindow(t: string, win: HourWin): boolean {
  const h = hourET(t);
  const mm = mmOf(t);
  if (win === "open") return (h === 9 && mm >= 30) || (h === 10 && mm < 30);
  if (win === "mid") return (h === 10 && mm >= 30) || h === 11 || h === 12;
  if (win === "pm") return h >= 13 && h <= 16;
  return true;
}

/* ---------------- per-session context (shared by all variants) ---- */

type SessionCtx = {
  minutes: MomMinute[];
  medVol: number[]; // trailing 60-bar median volume per bar
  atr14: number[]; // median range of prior 14 bars per bar
  cum15: number[]; // trailing 15-bar cumulative delta BEFORE bar k
  /** [buy-dominant rows, sell-dominant rows] per bar — whole bar */
  clustersWhole: [number, number][];
  /** [buy rows on the upper half, sell rows on the lower half] */
  clustersHalf: [number, number][];
};

function buildCtx(minutes: MomMinute[]): SessionCtx {
  const n = minutes.length;
  const medVol: number[] = new Array(n).fill(0);
  const atr14: number[] = new Array(n).fill(0);
  const cum15: number[] = new Array(n).fill(0);
  const clustersWhole: [number, number][] = new Array(n);
  const clustersHalf: [number, number][] = new Array(n);
  for (let k = 0; k < n; k++) {
    const m = minutes[k];
    const arr: number[] = [];
    for (let j = Math.max(0, k - MED_WINDOW); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
    medVol[k] = med(arr);
    atr14[k] = med(minutes.slice(Math.max(0, k - 14), k).map((x) => x.high - x.low));
    let cum = 0;
    for (let j = Math.max(0, k - 15); j < k; j++) cum += minutes[j].buy - minutes[j].sell;
    cum15[k] = cum;
    const mid = (m.high + m.low) / 2;
    let bw = 0, sw = 0, bh = 0, sl = 0;
    for (const l of m.levels) {
      const buyDom = l.buy >= 3 && l.buy >= 2 * l.sell;
      const sellDom = l.sell >= 3 && l.sell >= 2 * l.buy;
      if (buyDom) bw++;
      if (sellDom) sw++;
      if (buyDom && l.price >= mid) bh++;
      if (sellDom && l.price <= mid) sl++;
    }
    clustersWhole[k] = [bw, sw];
    clustersHalf[k] = [bh, sl];
  }
  return { minutes, medVol, atr14, cum15, clustersWhole, clustersHalf };
}

/* ---------------- detector ---------------- */

export type GateSignal = {
  dir: "long" | "short";
  entryIdx: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  t: string;
  hourET: number;
  frac: number;
  vol: number;
  medVol: number;
  rangeR: number;
  atr14: number;
  delta: number;
  cumDelta: number;
  pocPos: number;
  clusters: number;
};

export function detectRthGate(ctx: SessionCtx, cfg: GateConfig): GateSignal[] {
  const { minutes, medVol, atr14, cum15, clustersWhole, clustersHalf } = ctx;
  const n = minutes.length;
  const out: GateSignal[] = [];
  if (n < 30) return out;
  let lastSignal = -10_000;
  for (let k = 20; k < n; k++) {
    const m = minutes[k];
    if (!inRTH(m.t) || !inWindow(m.t, cfg.hourWin)) continue;
    if (k - lastSignal < cfg.minGapBars) continue;
    const vol = m.buy + m.sell;
    if (medVol[k] <= 0 || vol < cfg.volMedMult * medVol[k]) continue;
    const frac = vol > 0 ? m.buy / vol : 0.5;
    let dir: "long" | "short" | null = null;
    if (frac >= cfg.minBuyFrac) dir = "long";
    else if (frac <= 1 - cfg.minBuyFrac) dir = "short";
    if (!dir) continue;
    if (cfg.dir !== "both" && dir !== cfg.dir) continue;

    const range = m.high - m.low;
    if (range <= 0) continue;
    if (cfg.minRangeR > 0 && (atr14[k] <= 0 || range < cfg.minRangeR * atr14[k])) continue;

    const delta = m.buy - m.sell;
    if (cfg.trendAgree && (delta === 0 || Math.sign(delta) !== Math.sign(cum15[k]))) continue;

    const mid = (m.high + m.low) / 2;
    let clusters = 0;
    if (cfg.pocSide) {
      let pocPrice = NaN;
      let pocVol = -1;
      for (const l of m.levels) {
        const lv = l.buy + l.sell;
        if (lv > pocVol) {
          pocVol = lv;
          pocPrice = l.price;
        }
      }
      if (pocVol < 0) continue;
      const pos = (pocPrice - m.low) / range;
      if (!(dir === "long" ? pos >= 0.5 : pos <= 0.5)) continue;
    }
    if (cfg.tickProof) {
      clusters = dir === "long"
        ? (cfg.tickProofScope === "half" ? clustersHalf[k][0] : clustersWhole[k][0])
        : (cfg.tickProofScope === "half" ? clustersHalf[k][1] : clustersWhole[k][1]);
      if (clusters < cfg.tickProofN) continue;
    }

    const entry = closeOf(m);
    const stop = dir === "long" ? m.low - cfg.stopPad : m.high + cfg.stopPad;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk < cfg.minRiskPts || risk > cfg.maxRiskPts) continue;
    const target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
    lastSignal = k;
    out.push({
      dir,
      entryIdx: k,
      entry,
      stop,
      target,
      risk,
      t: m.t,
      hourET: hourET(m.t),
      frac,
      vol,
      medVol: medVol[k],
      rangeR: atr14[k] > 0 ? range / atr14[k] : 0,
      atr14: atr14[k],
      delta,
      cumDelta: cum15[k],
      pocPos: 0.5,
      clusters,
    });
  }
  return out;
}

/* ---------------- trade scoring ---------------- */

export type ScoredTrade = GateSignal & {
  date: string;
  exit: number;
  pnl: number; // net pts; 0 for time-out skips
  hit: "target" | "stop" | "time";
  heldBars: number;
  mfeR: number;
  maeR: number;
};

function scoreTrade(ctx: SessionCtx, sig: GateSignal, date: string): ScoredTrade | null {
  const { minutes } = ctx;
  const dir = sig.dir === "long" ? 1 : -1;
  const { entry, stop, target, risk } = sig;
  if (
    !(risk > 0) ||
    (dir > 0 && !(stop < entry && entry < target)) ||
    (dir < 0 && !(target < entry && entry < stop))
  )
    return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;

  let hit: ScoredTrade["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.entryIdx;
  let mfe = 0;
  let mae = 0;
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
  const pnl = hit === "time" ? 0 : (exit - entry) * dir - COST_PTS;
  return { ...sig, date, exit, pnl, hit, heldBars, mfeR: mfe, maeR: mae };
}

/* ---------------- aggregation ---------------- */

type DirAgg = { n: number; wins: number; wr: number };

export type Agg = {
  n: number; // decided trades (WR denominator)
  wins: number;
  skips: number; // time-out trades
  wr: number;
  pf: number;
  netPts: number;
  expPts: number; // netPts / (n + skips)
  avgRisk: number;
  mfe: number;
  mae: number;
  byYear: { year: string; n: number; wins: number; wr: number }[];
  long: DirAgg;
  short: DirAgg;
};

function aggregate(trades: ScoredTrade[]): Agg {
  const decided = trades.filter((t) => t.hit !== "time");
  const wins = decided.filter((t) => t.pnl > 0);
  const losses = decided.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = decided.reduce((a, t) => a + t.pnl, 0);

  const years = new Map<string, { n: number; wins: number }>();
  for (const t of decided) {
    const y = t.date.slice(0, 4);
    const e = years.get(y) ?? { n: 0, wins: 0 };
    e.n++;
    if (t.pnl > 0) e.wins++;
    years.set(y, e);
  }
  const byYear = [...years.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, e]) => ({ year, n: e.n, wins: e.wins, wr: e.n ? (e.wins / e.n) * 100 : 0 }));

  const dirAgg = (d: "long" | "short"): DirAgg => {
    const dd = decided.filter((t) => t.dir === d);
    const w = dd.filter((t) => t.pnl > 0).length;
    return { n: dd.length, wins: w, wr: dd.length ? (w / dd.length) * 100 : 0 };
  };

  return {
    n: decided.length,
    wins: wins.length,
    skips: trades.length - decided.length,
    wr: decided.length ? (wins.length / decided.length) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    netPts: net,
    expPts: trades.length ? net / trades.length : 0,
    avgRisk: decided.length ? decided.reduce((a, t) => a + t.risk, 0) / decided.length : 0,
    mfe: decided.length ? decided.reduce((a, t) => a + t.mfeR, 0) / decided.length : 0,
    mae: decided.length ? decided.reduce((a, t) => a + t.maeR, 0) / decided.length : 0,
    byYear,
    long: dirAgg("long"),
    short: dirAgg("short"),
  };
}

function fmtPf(pf: number): string {
  return Number.isFinite(pf) ? pf.toFixed(2) : "inf";
}

/* ---------------- footprint × candle-impact interaction table ---- */

const CLUSTER_LABELS = ["0", "1", "2", "3+"];
const SHARE_THRESH = [0.5, 0.6, 0.7];
const RANGE_THRESH = [0.8, 1.2, 1.6];
const CELL_MIN_N = 300;
const CELL_MIN_ACC = 75;

type Cell = {
  side: "buy" | "sell";
  cB: number; // cluster-count bucket 0/1/2/3
  sB: number; // share threshold index 0/1/2
  rB: number; // range threshold index 0/1/2
  n: number;
  up: number; // next-bar moves in the side's direction
};

function bucket3(x: number, th: number[]): number {
  // th = [lo, mid, hi]: 0 → [lo, mid), 1 → [mid, hi), 2 → [hi, ∞)
  if (x < th[1]) return 0;
  if (x < th[2]) return 1;
  return 2;
}

/** one full pass: bucket every RTH bar with a next bar into the cells */
function buildCells(ctxs: SessionCtx[]): Cell[] {
  const cells = new Map<string, Cell>();
  const key = (side: string, cB: number, sB: number, rB: number) => `${side}|${cB}|${sB}|${rB}`;
  for (const ctx of ctxs) {
    const { minutes, atr14, clustersWhole } = ctx;
    for (let k = 20; k < minutes.length - 1; k++) {
      const m = minutes[k];
      if (!inRTH(m.t)) continue;
      const vol = m.buy + m.sell;
      if (vol <= 0 || atr14[k] <= 0) continue;
      const range = m.high - m.low;
      const rR = range / atr14[k];
      if (rR < RANGE_THRESH[0]) continue;
      const rB = bucket3(rR, RANGE_THRESH);
      const frac = m.buy / vol;
      const nxt = closeOf(minutes[k + 1]);
      const cur = closeOf(m);
      for (const side of ["buy", "sell"] as const) {
        const share = side === "buy" ? frac : 1 - frac;
        if (share < SHARE_THRESH[0]) continue;
        const sB = bucket3(share, SHARE_THRESH);
        const c = side === "buy" ? clustersWhole[k][0] : clustersWhole[k][1];
        const cB = c >= 3 ? 3 : c;
        const id = key(side, cB, sB, rB);
        let cell = cells.get(id);
        if (!cell) {
          cell = { side, cB, sB, rB, n: 0, up: 0 };
          cells.set(id, cell);
        }
        cell.n++;
        const moved = side === "buy" ? nxt > cur : nxt < cur;
        if (moved) cell.up++;
      }
    }
  }
  return [...cells.values()];
}

function cellLabel(c: Cell): string {
  return `${c.side}·cl≥${CLUSTER_LABELS[c.cB]}·sh≥${SHARE_THRESH[c.sB].toFixed(1)}·rg≥${RANGE_THRESH[c.rB].toFixed(1)}`;
}

function cellVariant(c: Cell): { name: string; cfg: Partial<GateConfig> } {
  const cfg: Partial<GateConfig> = {
    minBuyFrac: SHARE_THRESH[c.sB],
    minRangeR: RANGE_THRESH[c.rB],
    tickProof: c.cB > 0,
    tickProofN: Math.max(1, c.cB),
    tickProofScope: "whole",
  };
  return {
    name: `r2cell-${c.side === "buy" ? "b" : "s"}${c.cB}s${SHARE_THRESH[c.sB] * 10}r${RANGE_THRESH[c.rB] * 10}`,
    cfg,
  };
}

/* ---------------- variants (iterated rounds) ---------------- */

export type Variant = { name: string; cfg: Partial<GateConfig> };

const ROUNDS: { round: number; label: string; variants: Variant[] }[] = [
  {
    round: 1,
    label: "axis sweeps — one dimension at a time",
    variants: [
      { name: "r1 base", cfg: {} },
      { name: "r1 frac62", cfg: { minBuyFrac: 0.62 } },
      { name: "r1 frac65", cfg: { minBuyFrac: 0.65 } },
      { name: "r1 frac68", cfg: { minBuyFrac: 0.68 } },
      { name: "r1 frac70", cfg: { minBuyFrac: 0.7 } },
      { name: "r1 vol1.0", cfg: { volMedMult: 1.0 } },
      { name: "r1 vol1.5", cfg: { volMedMult: 1.5 } },
      { name: "r1 trend15", cfg: { trendAgree: true } },
      { name: "r1 poc", cfg: { pocSide: true } },
      { name: "r1 candle0.8", cfg: { minRangeR: 0.8 } },
      { name: "r1 candle1.0", cfg: { minRangeR: 1.0 } },
      { name: "r1 hOpen", cfg: { hourWin: "open" } },
      { name: "r1 hMid", cfg: { hourWin: "mid" } },
      { name: "r1 hPm", cfg: { hourWin: "pm" } },
      { name: "r1 tick2", cfg: { tickProof: true } },
    ],
  },
  // Round 2 (combinations of the winning axes + top interaction cells)
  // and Round 3 (refinement) are appended after the round-1 readout.
];

/* ---------------- main ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const o: { round?: number; max?: number; sequential?: boolean; cells?: boolean; autoCells?: boolean; dump?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--round") o.round = Number(argv[++i]);
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--sequential") o.sequential = true;
    else if (a === "--cells") o.cells = true;
    else if (a === "--auto-cells") o.autoCells = true;
    else if (a === "--dump") o.dump = argv[++i];
  }

  let dates = await archiveDates();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);

  const loadAll = async (what: string): Promise<SessionCtx[]> => {
    const ctxs: SessionCtx[] = [];
    let loaded = 0;
    let failed = 0;
    let i = 0;
    const t0 = Date.now();
    console.log(`${what}: replaying ${dates.length} sessions…`);
    while (i < dates.length) {
      const chunk = dates.slice(i, i + CONCURRENCY);
      const rows = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
      for (const { minutes } of rows) {
        if (!minutes) {
          failed++;
          continue;
        }
        loaded++;
        ctxs.push(buildCtx(minutes));
      }
      i += CONCURRENCY;
      if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
    }
    console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${loaded} sessions · ${failed} failed`);
    return ctxs;
  };

  /* ---- phase A: interaction cells ---- */
  let autoVariants: { name: string; cfg: Partial<GateConfig> }[] = [];
  if (o.cells || o.autoCells) {
    const ctxs = await loadAll("cells pass");
    const cells = buildCells(ctxs);
    cells.sort((a, b) => b.up / b.n - a.up / a.n || b.n - a.n);
    console.log("\n=== INTERACTION TABLE: next-bar directional accuracy by cell ===");
    console.log("cell                          n       acc%");
    const qualifying: Cell[] = [];
    for (const c of cells) {
      const acc = (c.up / c.n) * 100;
      const ok = c.n >= CELL_MIN_N && acc >= CELL_MIN_ACC;
      if (ok) qualifying.push(c);
      console.log(
        `${cellLabel(c).padEnd(28)} ${String(c.n).padStart(7)} ${acc.toFixed(1).padStart(9)}${ok ? "  ★" : ""}`,
      );
    }
    console.log(`\ncells with n≥${CELL_MIN_N} and acc≥${CELL_MIN_ACC}%: ${qualifying.length}`);
    if (o.autoCells) {
      autoVariants = qualifying
        .sort((a, b) => b.up / b.n - a.up / a.n || b.n - a.n)
        .slice(0, 20)
        .map(cellVariant);
      console.log(`auto-variants from top cells: ${autoVariants.map((v) => v.name).join(", ")}`);
    }
  }

  /* ---- phase B: sweep ---- */
  const rounds = o.round ? ROUNDS.filter((r) => r.round === o.round) : ROUNDS;
  const variants: { round: number; label: string; name: string; cfg: GateConfig }[] = [];
  for (const r of rounds) {
    for (const v of r.variants) variants.push({ round: r.round, label: r.label, name: v.name, cfg: { ...GATE_DEFAULTS, ...v.cfg } });
  }
  for (const v of autoVariants) {
    variants.push({ round: 2, label: "auto — top interaction cells", name: v.name, cfg: { ...GATE_DEFAULTS, ...v.cfg } });
  }
  if (!variants.length && !o.cells) {
    console.error("no variants to run");
    process.exit(1);
  }
  if (variants.length) {
    console.log(`\nvariants (${variants.length}): ${variants.map((v) => v.name).join(", ")}${o.sequential ? " · SEQUENTIAL" : ""}`);
    const ctxs = await loadAll("sweep pass");
    const perVariant: ScoredTrade[][] = variants.map(() => []);
    for (const ctx of ctxs) {
      const date = ctx.minutes[0]?.d ?? "";
      for (let v = 0; v < variants.length; v++) {
        const signals = detectRthGate(ctx, variants[v].cfg);
        let trades = signals.map((s) => scoreTrade(ctx, s, date)).filter((t): t is ScoredTrade => t !== null);
        if (o.sequential) {
          const kept: ScoredTrade[] = [];
          let openUntil = -1;
          for (const t of trades) {
            if (t.entryIdx <= openUntil) continue;
            kept.push(t);
            openUntil = t.entryIdx + t.heldBars;
          }
          trades = kept;
        }
        perVariant[v].push(...trades);
      }
    }

    const agg = variants.map((v, idx) => ({ ...v, idx, s: aggregate(perVariant[idx]) }));

    for (const r of rounds) {
      const rows = agg.filter((a) => a.round === r.round);
      if (!rows.length) continue;
      rows.sort((x, y) => y.s.wr - x.s.wr || y.s.expPts - x.s.expPts);
      console.log(`\n=== ROUND ${r.round}: ${r.label}`);
      console.log("variant             n    wr%    pf   netPts expPts  skips  L(n/wr%)   S(n/wr%)");
      for (const row of rows) {
        const flag = row.s.wr >= WR_TARGET && row.s.n >= MIN_DECIDED ? " ★" : "";
        console.log(
          `${row.name.padEnd(18)}${String(row.s.n).padStart(5)} ${row.s.wr.toFixed(1).padStart(6)} ${fmtPf(row.s.pf).padStart(5)} ${row.s.netPts.toFixed(0).padStart(7)} ${row.s.expPts.toFixed(2).padStart(7)} ${String(row.s.skips).padStart(6)}  ${`${row.s.long.n}/${row.s.long.wr.toFixed(1)}`.padStart(8)} ${`${row.s.short.n}/${row.s.short.wr.toFixed(1)}`.padStart(9)}${flag}`,
        );
      }
    }
    if (autoVariants.length) {
      const rows = agg.filter((a) => a.round === 2 && a.name.startsWith("r2cell-"));
      rows.sort((x, y) => y.s.wr - x.s.wr || y.s.expPts - x.s.expPts);
      console.log("\n=== ROUND 2 (auto): top interaction cells as 1R variants");
      console.log("variant             n    wr%    pf   netPts expPts  skips  L(n/wr%)   S(n/wr%)");
      for (const row of rows) {
        const flag = row.s.wr >= WR_TARGET && row.s.n >= MIN_DECIDED ? " ★" : "";
        console.log(
          `${row.name.padEnd(18)}${String(row.s.n).padStart(5)} ${row.s.wr.toFixed(1).padStart(6)} ${fmtPf(row.s.pf).padStart(5)} ${row.s.netPts.toFixed(0).padStart(7)} ${row.s.expPts.toFixed(2).padStart(7)} ${String(row.s.skips).padStart(6)}  ${`${row.s.long.n}/${row.s.long.wr.toFixed(1)}`.padStart(8)} ${`${row.s.short.n}/${row.s.short.wr.toFixed(1)}`.padStart(9)}${flag}`,
        );
      }
    }

    /* ---- best config: WR ≥ 75% with n ≥ 300, else closest ---- */
    const qualified = agg.filter((a) => a.s.n >= MIN_DECIDED);
    const atTarget = qualified.filter((a) => a.s.wr >= WR_TARGET);
    const best = (atTarget.length ? atTarget : qualified).sort((x, y) => y.s.wr - x.s.wr || y.s.expPts - x.s.expPts)[0];
    console.log(
      `\nbest: ${best.name} (${atTarget.length ? `${atTarget.length} variant(s) at ≥${WR_TARGET}% WR` : `no variant reached ${WR_TARGET}% WR with n≥${MIN_DECIDED}`})`,
    );
    console.log("config:", JSON.stringify(best.cfg));
    console.log("\nby-year WR:");
    for (const y of best.s.byYear) {
      console.log(`  ${y.year}: n=${String(y.n).padStart(4)} wr=${y.wr.toFixed(1)}% (${y.wins}/${y.n})`);
    }

    /* ---- MFF grounding ---- */
    console.log("\nACCOUNT (Rapid EOD 50k · $170/trade budget · 30-micro cap · EOD MLL $2,000):");
    for (const a of agg) {
      const d = dollarize(perVariant[a.idx].map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
      const evalS = simulateAccount(d, "eval");
      const fundedS = simulateAccount(d, "funded");
      console.log(
        `${a.name.padEnd(18)} | eval ${accountLine(evalS).padEnd(64)} | funded ${accountLine(fundedS)}`,
      );
    }
    const bd = dollarize(perVariant[best.idx].map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const bEval = simulateAccount(bd, "eval");
    const bFunded = simulateAccount(bd, "funded");
    console.log(`\nbest "${best.name}" account detail:`);
    console.log(
      `  eval:  final $${bEval.finalEquity.toFixed(0)} · profit $${bEval.totalProfit.toFixed(0)} · bestDay $${bEval.bestDay.toFixed(0)} · consist ${bEval.consistencyOk} · minDays ${bEval.minDaysOk} · breach ${bEval.breachDay ?? "none"}`,
    );
    console.log(
      `  funded: final $${bFunded.finalEquity.toFixed(0)} · payouts ${bFunded.payouts} · floor $${bFunded.floor.toFixed(0)}${bFunded.locked ? " (locked)" : ""} · breach ${bFunded.breachDay ?? "none"}`,
    );

    /* ---- dump ---- */
    const dumpPath = o.dump ?? "/tmp/rth_gate_trades.json";
    await fs.writeFile(
      dumpPath,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          config: best.cfg,
          stats: { ...best.s, expPts: Number(best.s.expPts.toFixed(3)) },
          accountEval: bEval,
          accountFunded: bFunded,
          trades: perVariant[best.idx],
        },
        null,
        1,
      ),
    );
    console.log(`\nbest-config trades dumped → ${dumpPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
