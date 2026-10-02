/* ------------------------------------------------------------------ *
 * Momentum detector — the "join the one-sided run" signal.
 *
 * Reads the tape as a four-state sequence, per direction:
 *
 *   S1 FLUSH     one-sided counter-move (>=1-flushFrac on the flush side)
 *   S1 gate      the flush FAILED: it made no new session extreme
 *                (effort without result — sellers can't break the low)
 *   S2 RESPONSE  one-sided trade-direction bar within `respWindow` bars,
 *                closing back above (long) the flush bar's close, with
 *                tick-level proof: >=`respProofN` clusters of >=`respProofLots`
 *                lots, `respProofRatio`-dominant, at/inside the flush zone
 *   S4 BREAKOUT  one-sided trade-direction bar that trades THROUGH the
 *                reference extreme (max high of the flush bar and the two
 *                bars before it) — THE SIGNAL (optionally confirmed by
 *                `holdBars` of no-give-back bars before entry)
 *
 * Everything is computed from completed bars only — no lookahead.
 * Mirrored for shorts (failed rally → one-sided sell response → break down).
 * Pure function of the minute array + config: unit-testable, replayable.
 * ------------------------------------------------------------------ */

import { imbalanceFor } from "./imbalance";

export type MomMinute = {
  t: string;
  d: string;
  o: number;
  c: number; // true close when OHLC exists, else 0 (mid is used)
  high: number;
  low: number;
  buy: number;
  sell: number;
  levels: { price: number; buy: number; sell: number }[];
};

export type MomConfig = {
  /** S1 flush: max trade-direction share (long flush is sell-side) */
  flushFrac: number;
  flushVolFloor: number;
  flushVolMedMult: number;
  /** a "failed" flush may dip up to this many pts beyond the session extreme */
  failTolPts: number;
  /** S2 response */
  respFrac: number;
  respVolFloor: number;
  respVolMedMult: number;
  respWindow: number;
  respProofLots: number;
  respProofRatio: number;
  respProofN: number;
  /** response close must sit >= this fraction of the flush range above the
   *  flush low (0 = no position requirement). Position-based because the
   *  archive has no true closes — mid is the honest proxy. */
  respPosMin: number;
  /** S4 breakout */
  breakFrac: number;
  breakVolFloor: number;
  breakVolMedMult: number;
  breakWindow: number;
  /** where the sequence fires: "breakout" (the validated signal) or the
   *  earlier stages — "response" (fire on the one-sided response bar) or
   *  "flush" (fire on the failed flush bar itself). Early fires use the
   *  structural flush-extreme stop. */
  fireAt: "breakout" | "response" | "flush";
  /** require a separate one-sided response bar before the breakout. false =
   *  merged mode: the breakout bar itself is the response evidence (covers
   *  flush → immediate breakout sequences). */
  needResponse: boolean;
  /** confirm the breakout with `holdBars` no-give-back bars before entry */
  holdBars: number;
  holdTolPts: number;
  /** reference = flush bar + this many bars before it */
  refLookback: number;
  /** require price on the session VWAP side of the trade */
  requireVwapSide: boolean;
  /** breakout must make a NEW session extreme (long: high > session high) */
  requireProgress: boolean;
  /** cumulative delta since the flush must agree with the trade */
  deltaConfirm: boolean;
  /** stopMode: "flush" = flush extreme ∓ stopPad; "breakout" = breakout bar low/high ∓ stopPad */
  stopMode: "flush" | "breakout";
  /** structural stop = flush extreme ∓ stopPad */
  stopPad: number;
  /** target = entry ± targetR × risk */
  targetR: number;
  maxRiskPts: number;
  /** skip setups whose risk is below this (noise floor) */
  minRiskPts: number;
  /** ignore new flushes for this many bars after a signal */
  minGapBars: number;
  /** trailing window (bars) for the session median volume */
  medWindow: number;
  /** cap the median-multiplier volume floors at this many contracts
   *  (0 = off). RTH medians are 20× the overnight ones, so an uncapped
   *  multiplier makes the gates unreachable mid-session. */
  volCapAbs: number;
  /** hour filter: "none" = all hours, "globex" = skip RTH (9:30–16:00 ET) */
  hourFilter: "none" | "globex" | "globexOpen" | "globexCore";
  /** breakout bar quality: minimum range ÷ ATR14 (candle size filter;
   *  0 = off). The feature study: big one-sided bars continue, small bars
   *  don't. */
  minBreakRangeR: number;
  /** breakout bar density: volume-per-point ÷ its trailing median (the
   *  study's effRel — a wide bar on thin prints fails this even when the
   *  ATR gate passes). 0 = off. */
  minBreakEffR?: number;
  /** breakout bar order-flow conviction: minimum diagonal-imbalance
   *  levels (3:1 buy lifting the level below's sell, or the short
   *  mirror) on the trade side. 0 = off. */
  minBreakDiag?: number;
  /** require a dominant cluster stack on the breakout bar, matching the
   *  trade direction (buy stack for longs). Feature study: big bar + buy
   *  stack → 77% next-bar up. */
  requireBreakStack: boolean;
  /** the bar BEFORE the flush must be quiet (range < 0.7× ATR14) — the
   *  compression → expansion lead from the feature study (quiet bars
   *  precede signals at ~2× the baseline rate). */
  quietBeforeFlush: boolean;
  /** skip breakout bars that are churn: both buy AND sell dominant clusters
   *  present (both-side diagonals = two-way volatility, not a run). */
  churnVeto: boolean;
  /** breakout bar's candle POC must sit in the trade direction's half
   *  (top half for longs) — the POC-position lead (57% vs 43% next-bar up). */
  requireBreakPoc: boolean;
  /** breakout bar's POC must migrate in the trade direction vs the prior
   *  bar (POC up >0 for longs) — the POC-migration lead (59% vs 40%). */
  requirePocMove: boolean;
  /** what the flush must fail to break: "session" = the day's running
   *  extreme (only meaningful near the extremes), "local" = the trailing
   *  failLocalBars-bar extreme (the last swing low/high — measures effort
   *  vs result at ANY location). */
  failAnchor: "session" | "local";
  failLocalBars: number;
  /** breakout must clear the trailing trailProgBars-bar extreme in the trade
   *  direction (long: high above the trailing high) — vetoes breakouts that
   *  fire INSIDE overhead congestion rather than through it (the 21:18
   *  failed-breakout class from the 2026-10-02 trade review). */
  requireTrailProgress: boolean;
  trailProgBars: number;
  /** wider stop pad in the 00:00–02:00 ET window (undefined = off) — the
   *  stop-run study's hour-conditional pad candidate. */
  stopPadNight?: number;
};

export const MOM_DEFAULTS: MomConfig = {
  flushFrac: 0.3,
  flushVolFloor: 15,
  flushVolMedMult: 0.5,
  failTolPts: 0.5,
  respFrac: 0.65,
  respVolFloor: 10,
  respVolMedMult: 0.4,
  respWindow: 2,
  respProofLots: 3,
  respProofRatio: 1.5,
  respProofN: 2,
  respPosMin: 0.35,
  breakFrac: 0.65,
  breakVolFloor: 15,
  breakVolMedMult: 0.5,
  breakWindow: 6,
  fireAt: "breakout",
  needResponse: true,
  holdBars: 0,
  holdTolPts: 1.0,
  refLookback: 2,
  requireVwapSide: false,
  requireProgress: false,
  deltaConfirm: false,
  stopMode: "flush",
  stopPad: 0.5,
  targetR: 1,
  maxRiskPts: 30,
  minRiskPts: 0,
  minGapBars: 5,
  medWindow: 60,
  volCapAbs: 250,
  hourFilter: "none",
  minBreakRangeR: 0,
  requireBreakStack: false,
  quietBeforeFlush: false,
  churnVeto: false,
  requireBreakPoc: false,
  requirePocMove: false,
  failAnchor: "session",
  failLocalBars: 20,
  requireTrailProgress: false,
  trailProgBars: 20,
};

/** The production momentum config — see MOMENTUM_SIGNAL.md.
 *  Quality-filter sweep 2026-10-02 (648 sessions, Globex-filtered): the
 *  ATR size gate at 1.0 beats 0.85 on WR (75.6 vs 75.2), PF (2.71 vs 2.65)
 *  AND total net (+4482 vs +4475) at nearly the same trade count — the
 *  footprint gates (stack/churn/POC/quiet/diag/eff) all trade total net
 *  for per-trade quality (see research/quality-filter-sweep-2026-10-02.md). */
export const MOM_PROD: MomConfig = {
  ...MOM_DEFAULTS,
  needResponse: false,
  stopMode: "breakout",
  stopPad: 0.5,
  breakFrac: 0.75,
  breakWindow: 10,
  minRiskPts: 3,
  targetR: 1,
  hourFilter: "globex",
  minBreakRangeR: 1.0,
};

export type MomentumSignal = {
  dir: "long" | "short";
  /** which trigger produced the signal: the failed-flush sequence or the
   *  standalone huge-bar expansion scalp */
  kind: "flush" | "expansion";
  flushIdx: number;
  respIdx: number;
  breakIdx: number;
  entryIdx: number; // bar whose close is the entry (breakIdx + holdBars)
  entry: number;
  stop: number;
  target: number;
  risk: number;
  t: string; // feed clock HH:mm of the entry bar
  d: string; // feed calendar date of the entry bar
  hourET: number;
  // features — all known at entry time, recorded for threshold iteration
  flushFrac: number;
  flushVol: number;
  flushRange: number;
  failDepth: number; // pts the flush missed the session extreme by (>0 = failed)
  respFrac: number;
  respVol: number;
  respDelay: number;
  respProof: number;
  breakFrac: number;
  breakVol: number;
  breakDelay: number;
  refDist: number; // entry vs the broken reference, pts (>0 = through)
  progressPts: number; // breakout high vs session high at flush time (long)
  medVol: number;
  distVwapPts: number;
  cumDelta: number;
  deltaFromFlush: number;
  atr14: number;
  riskPts: number;
  /** breakout bar efficiency density (volume-per-point ÷ trailing median) */
  breakEffR?: number;
  /** breakout bar diagonal-imbalance levels on the trade side */
  breakDiag?: number;
  /** flush vs the trailing 20-bar low/high — the local context of the probe */
  trailLowDist: number;
  trailHighDist: number;
  /** breakout bar candle-size × footprint features (see footprintCandleStudy) */
  breakRangeR: number;
  breakStack: "buy" | "sell" | "none";
  breakVwapPos: number;
  flushRangeR: number;
};

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export const closeOf = (m: MomMinute): number => (m.c > 0 ? m.c : (m.high + m.low) / 2);
export const midOf = (m: MomMinute): number => (m.high + m.low) / 2;

/** count dominant-side clusters: rows with side >= lots and side >= ratio*opp */
function clusterProof(
  levels: { price: number; buy: number; sell: number }[],
  side: "buy" | "sell",
  lots: number,
  ratio: number,
  priceFilter?: (p: number) => boolean,
): number {
  let n = 0;
  for (const l of levels) {
    if (priceFilter && !priceFilter(l.price)) continue;
    const s = side === "buy" ? l.buy : l.sell;
    const o = side === "buy" ? l.sell : l.buy;
    if (s >= lots && s >= ratio * o) n++;
  }
  return n;
}

type Watch = {
  dir: "long" | "short";
  flushIdx: number;
  flushHigh: number;
  flushLow: number;
  flushClose: number;
  flushFrac: number;
  flushVol: number;
  flushRange: number;
  failDepth: number;
  refHigh: number;
  refLow: number;
  respIdx: number;
  respFrac: number;
  respVol: number;
  respProof: number;
  trailLowDist: number;
  trailHighDist: number;
};

/** dominant cluster stack on a bar: ≥3 price rows with side ≥3 lots and
 *  ≥2× the opposite side, one side clearly ahead. */
function barStack(levels: { price: number; buy: number; sell: number }[]): "buy" | "sell" | "none" {
  let buy = 0;
  let sell = 0;
  for (const l of levels) {
    if (l.buy >= 3 && l.buy >= 2 * l.sell) buy++;
    if (l.sell >= 3 && l.sell >= 2 * l.buy) sell++;
  }
  if (buy >= 3 && buy > sell) return "buy";
  if (sell >= 3 && sell > buy) return "sell";
  return "none";
}

/** diagonal-imbalance levels on one side (the study's dBuy/dSell) —
 *  aggressive lifting/hitting rows: >=10 lots and >=3x the level beyond. */
function diagCount(levels: MomMinute["levels"], side: "buy" | "sell"): number {
  const sorted = [...levels].sort((a, b) => b.price - a.price);
  const fp = imbalanceFor(sorted.map((l) => ({ price: l.price, buy: l.buy, sell: l.sell })));
  let n = 0;
  for (const l of fp) {
    if (side === "buy" && l.dBuy) n++;
    if (side === "sell" && l.dSell) n++;
  }
  return n;
}

/** volume-weighted price position inside the bar's range (0..1) */
function barVwapPos(levels: { price: number; buy: number; sell: number }[], range: number, low: number): number {
  if (!(range > 0.25)) return 0.5;
  let num = 0;
  let den = 0;
  for (const l of levels) {
    const v = l.buy + l.sell;
    num += l.price * v;
    den += v;
  }
  return den > 0 ? (num / den - low) / range : 0.5;
}

/** candle POC position: the most-traded price, as 0..1 of the bar's range */
function barPocPos(levels: { price: number; buy: number; sell: number }[], range: number, low: number): number {
  let pocPrice = 0;
  let pocVol = -1;
  for (const l of levels) {
    const v = l.buy + l.sell;
    if (v > pocVol) {
      pocVol = v;
      pocPrice = l.price;
    }
  }
  return range > 0.25 && pocPrice > 0 ? (pocPrice - low) / range : 0.5;
}

/** RTH exclusion per the hour filter. "globexOpen" allows the 9:30-9:59
 *  opening drive but excludes the rest of RTH (10:00-16:00). */
function rthBlocked(hh: number, mm: number, filter: "none" | "globex" | "globexOpen" | "globexCore"): boolean {
  if (filter === "none") return false;
  if (filter === "globexOpen") return (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
  if (filter === "globexCore") return (hh === 19) || (hh === 23) || (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
  return (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
}

export function detectMomentum(minutes: MomMinute[], cfg: MomConfig = MOM_DEFAULTS): MomentumSignal[] {
  const n = minutes.length;
  const out: MomentumSignal[] = [];
  if (n < 30) return out;

  // session prefixes: vwap + cumulative delta (lookahead-free)
  const vwap: number[] = new Array(n);
  const cumD: number[] = new Array(n);
  {
    let vn = 0;
    let vd = 0;
    let cd = 0;
    for (let i = 0; i < n; i++) {
      const m = minutes[i];
      const v = m.buy + m.sell;
      if (v > 0) {
        vn += ((m.high + m.low + closeOf(m)) / 3) * v;
        vd += v;
      }
      vwap[i] = vd > 0 ? vn / vd : 0;
      cd += m.buy - m.sell;
      cumD[i] = cd;
    }
  }

  const medAt = (i: number): number => {
    const from = Math.max(0, i - cfg.medWindow);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].buy + minutes[k].sell);
    return med(arr);
  };
  /** trailing median of volume-per-point (the study's efficiency baseline) */
  const effMedAt = (i: number): number => {
    const from = Math.max(0, i - 60);
    const arr: number[] = [];
    for (let k = from; k < i; k++) {
      const m = minutes[k];
      arr.push((m.buy + m.sell) / Math.max(0.5, m.high - m.low));
    }
    return med(arr);
  };
  const atrAt = (i: number): number => {
    const from = Math.max(0, i - 14);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].high - minutes[k].low);
    return med(arr);
  };
  const trailExtremes = (i: number, w = 20): { lo: number; hi: number } => {
    const from = Math.max(0, i - w);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = from; k < i; k++) {
      lo = Math.min(lo, minutes[k].low);
      hi = Math.max(hi, minutes[k].high);
    }
    return { lo, hi };
  };
  const volOk = (vol: number, m: number, floor: number, mult: number) => {
    let need = mult * m;
    if (cfg.volCapAbs > 0) need = Math.min(need, cfg.volCapAbs);
    return vol >= Math.max(floor, need);
  };
  const fracOf = (m: MomMinute): number => {
    const v = m.buy + m.sell;
    return v > 0 ? m.buy / v : 0.5;
  };
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;

  let sessHi = -Infinity;
  let sessLo = Infinity;
  let lastSignalIdx = -10_000;

  let longWatch: Watch | null = null;
  let shortWatch: Watch | null = null;

  const startLong = (i: number): Watch | null => {
    const m = minutes[i];
    const frac = fracOf(m);
    if (frac > cfg.flushFrac) return null;
    if (!volOk(m.buy + m.sell, medAt(i), cfg.flushVolFloor, cfg.flushVolMedMult)) return null;
    const anchorLow = cfg.failAnchor === "local" ? trailExtremes(i, cfg.failLocalBars).lo : sessLo;
    if (m.low < anchorLow - cfg.failTolPts) return null; // real breakdown — not ours
    if (cfg.quietBeforeFlush && i >= 1) {
      const pr = minutes[i - 1];
      const prr = (pr.high - pr.low) / Math.max(0.25, atrAt(i - 1));
      if (prr >= 0.7) return null; // no compression before the flush — skip
    }
    const from = Math.max(0, i - cfg.refLookback);
    let refHigh = -Infinity;
    for (let k = from; k <= i; k++) refHigh = Math.max(refHigh, minutes[k].high);
    const tr = trailExtremes(i);
    return {
      dir: "long",
      flushIdx: i,
      flushHigh: m.high,
      flushLow: m.low,
      flushClose: closeOf(m),
      flushFrac: frac,
      flushVol: m.buy + m.sell,
      flushRange: m.high - m.low,
      failDepth: m.low - sessLo,
      refHigh,
      refLow: -Infinity,
      respIdx: -1,
      respFrac: 0,
      respVol: 0,
      respProof: 0,
      trailLowDist: m.low - tr.lo,
      trailHighDist: tr.hi - m.high,
    };
  };

  const startShort = (i: number): Watch | null => {
    const m = minutes[i];
    const frac = fracOf(m);
    if (frac < 1 - cfg.flushFrac) return null;
    if (!volOk(m.buy + m.sell, medAt(i), cfg.flushVolFloor, cfg.flushVolMedMult)) return null;
    const anchorHigh = cfg.failAnchor === "local" ? trailExtremes(i, cfg.failLocalBars).hi : sessHi;
    if (m.high > anchorHigh + cfg.failTolPts) return null; // real breakout up — not ours
    if (cfg.quietBeforeFlush && i >= 1) {
      const pr = minutes[i - 1];
      const prr = (pr.high - pr.low) / Math.max(0.25, atrAt(i - 1));
      if (prr >= 0.7) return null;
    }
    const from = Math.max(0, i - cfg.refLookback);
    let refLow = Infinity;
    for (let k = from; k <= i; k++) refLow = Math.min(refLow, minutes[k].low);
    const tr = trailExtremes(i);
    return {
      dir: "short",
      flushIdx: i,
      flushHigh: m.high,
      flushLow: m.low,
      flushClose: closeOf(m),
      flushFrac: frac,
      flushVol: m.buy + m.sell,
      flushRange: m.high - m.low,
      failDepth: sessHi - m.high,
      refHigh: Infinity,
      refLow,
      respIdx: -1,
      respFrac: 0,
      respVol: 0,
      respProof: 0,
      trailLowDist: m.low - tr.lo,
      trailHighDist: tr.hi - m.high,
    };
  };

  const tryResponse = (i: number, w: Watch): boolean => {
    const m = minutes[i];
    const frac = fracOf(m);
    const medv = medAt(i);
    if (w.dir === "long") {
      if (frac < cfg.respFrac) return false;
      if (!volOk(m.buy + m.sell, medv, cfg.respVolFloor, cfg.respVolMedMult)) return false;
      if (cfg.respPosMin > 0 && closeOf(m) < w.flushLow + cfg.respPosMin * w.flushRange) return false;
      const proof = clusterProof(m.levels, "buy", cfg.respProofLots, cfg.respProofRatio, (p) => p <= midOf(minutes[w.flushIdx]) + 1.0);
      if (proof < cfg.respProofN) return false;
      w.respIdx = i;
      w.respFrac = frac;
      w.respVol = m.buy + m.sell;
      w.respProof = proof;
      return true;
    }
    if (frac > 1 - cfg.respFrac) return false;
    if (!volOk(m.buy + m.sell, medv, cfg.respVolFloor, cfg.respVolMedMult)) return false;
    if (cfg.respPosMin > 0 && closeOf(m) > w.flushHigh - cfg.respPosMin * w.flushRange) return false;
    const proof = clusterProof(m.levels, "sell", cfg.respProofLots, cfg.respProofRatio, (p) => p >= midOf(minutes[w.flushIdx]) - 1.0);
    if (proof < cfg.respProofN) return false;
    w.respIdx = i;
    w.respFrac = frac;
    w.respVol = m.buy + m.sell;
    w.respProof = proof;
    return true;
  };

  const emit = (k: number, w: Watch, at: number, sigIdx: number): MomentumSignal | null => {
    const bk = minutes[k];
    const entryBar = minutes[at];
    const entry = closeOf(entryBar);
    const dir = w.dir;
    // non-breakout fires have no breakout bar — they always use the
    // structural stop under the flush extreme
    const hET = hourET(entryBar.t);
    const pad = cfg.stopPadNight !== undefined && hET >= 0 && hET < 2 ? cfg.stopPadNight : cfg.stopPad;
    const stop =
      cfg.stopMode === "breakout" && cfg.fireAt === "breakout"
        ? dir === "long"
          ? bk.low - pad
          : bk.high + pad
        : dir === "long"
          ? w.flushLow - pad
          : w.flushHigh + pad;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk > cfg.maxRiskPts || risk < cfg.minRiskPts) return null;
    if (cfg.requireVwapSide) {
      const v = vwap[at];
      if (dir === "long" && entry < v) return null;
      if (dir === "short" && entry > v) return null;
    }
    if (cfg.requireProgress) {
      if (dir === "long" && bk.high <= sessHi) return null;
      if (dir === "short" && bk.low >= sessLo) return null;
    }
    if (cfg.requireTrailProgress && cfg.fireAt === "breakout") {
      const tr = trailExtremes(k, cfg.trailProgBars);
      if (dir === "long" && bk.high <= tr.hi) return null;
      if (dir === "short" && bk.low >= tr.lo) return null;
    }
    if (rthBlocked(hourET(entryBar.t), Number(entryBar.t.slice(3, 5)), cfg.hourFilter)) return null;
    if (cfg.deltaConfirm) {
      const d = cumD[at] - cumD[w.flushIdx];
      if (dir === "long" && d <= 0) return null;
      if (dir === "short" && d >= 0) return null;
    }
    // candle-size × footprint quality gates (footprintCandleStudy findings:
    // big one-sided bars continue, small bars don't; a direction-matching
    // cluster stack on the breakout bar raises next-bar continuation to ~77%)
    const bkRange = bk.high - bk.low;
    const breakRangeR = bkRange / Math.max(0.25, atrAt(k));
    const breakStack = barStack(bk.levels);
    if (cfg.minBreakRangeR > 0 && breakRangeR < cfg.minBreakRangeR) return null;
    const bkEffR = (bk.buy + bk.sell) / Math.max(0.5, bkRange) / Math.max(0.25, effMedAt(k));
    const bkDiag = diagCount(bk.levels, dir === "long" ? "buy" : "sell");
    if ((cfg.minBreakEffR ?? 0) > 0 && bkEffR < (cfg.minBreakEffR ?? 0)) return null;
    if ((cfg.minBreakDiag ?? 0) > 0 && bkDiag < (cfg.minBreakDiag ?? 0)) return null;
    if (cfg.requireBreakStack && breakStack !== (dir === "long" ? "buy" : "sell")) return null;
    if (cfg.churnVeto) {
      let domBuy = 0;
      let domSell = 0;
      for (const l of bk.levels) {
        if (l.buy >= 3 && l.buy >= 2 * l.sell) domBuy++;
        if (l.sell >= 3 && l.sell >= 2 * l.buy) domSell++;
      }
      if (domBuy >= 3 && domSell >= 3) return null; // churn bar — two-way, not a run
    }
    // candle POC gates (feature study: POC at the bar's top → 57% next-bar
    // up vs 43% at the bottom; POC migrating up >1 pt → 59% vs 40%)
    const breakPocPos = barPocPos(bk.levels, bkRange, bk.low);
    let breakPocMove = 0;
    if (k >= 1) {
      const pr = minutes[k - 1];
      const prRange = pr.high - pr.low;
      const prPoc = prRange > 0.25 ? barPocPos(pr.levels, prRange, pr.low) * prRange + pr.low : 0;
      if (prPoc > 0) breakPocMove = breakPocPos * bkRange + bk.low - prPoc;
    }
    if (cfg.requireBreakPoc && (dir === "long" ? breakPocPos < 0.5 : breakPocPos > 0.5)) return null;
    if (cfg.requirePocMove && (dir === "long" ? breakPocMove <= 0 : breakPocMove >= 0)) return null;
    const target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
    const flushBar = minutes[w.flushIdx];
    const respBar = minutes[w.respIdx];
    return {
      dir,
      kind: "flush" as const,
      flushIdx: w.flushIdx,
      respIdx: w.respIdx,
      breakIdx: k,
      entryIdx: at,
      entry,
      stop,
      target,
      risk,
      t: entryBar.t,
      d: entryBar.d,
      hourET: hourET(entryBar.t),
      flushFrac: w.flushFrac,
      flushVol: w.flushVol,
      flushRange: w.flushRange,
      failDepth: w.failDepth,
      respFrac: w.respFrac,
      respVol: w.respVol,
      respDelay: w.respIdx - w.flushIdx,
      respProof: w.respProof,
      breakFrac: fracOf(bk),
      breakVol: bk.buy + bk.sell,
      breakDelay: k - w.respIdx,
      refDist: dir === "long" ? entry - w.refHigh : w.refLow - entry,
      progressPts: dir === "long" ? bk.high - sessHi : sessLo - bk.low,
      medVol: medAt(at),
      distVwapPts: entry - vwap[at],
      cumDelta: cumD[at],
      deltaFromFlush: cumD[at] - cumD[w.flushIdx],
      atr14: atrAt(at),
      riskPts: risk,
      trailLowDist: w.trailLowDist,
      trailHighDist: w.trailHighDist,
      breakRangeR,
      breakEffR: bkEffR,
      breakDiag: bkDiag,
      breakStack,
      breakVwapPos: barVwapPos(bk.levels, bkRange, bk.low),
      flushRangeR: flushBar.high - flushBar.low === 0 ? 0 : (flushBar.high - flushBar.low) / Math.max(0.25, atrAt(w.flushIdx)),
    } satisfies MomentumSignal;
  };

  /** breakout gate shared by both directions; in merged mode (needResponse
   *  false) the breakout bar records itself as the response evidence. */
  const tryBreakout = (i: number, w: Watch): { fired: MomentumSignal | null; done: boolean } => {
    const m = minutes[i];
    const frac = fracOf(m);
    const pass =
      w.dir === "long"
        ? frac >= cfg.breakFrac &&
          volOk(m.buy + m.sell, medAt(i), cfg.breakVolFloor, cfg.breakVolMedMult) &&
          m.high > w.refHigh
        : frac <= 1 - cfg.breakFrac &&
          volOk(m.buy + m.sell, medAt(i), cfg.breakVolFloor, cfg.breakVolMedMult) &&
          m.low < w.refLow;
    if (!pass) return { fired: null, done: false };
    if (w.respIdx < 0) {
      w.respIdx = i;
      w.respFrac = frac;
      w.respVol = m.buy + m.sell;
      w.respProof = clusterProof(
        m.levels,
        w.dir === "long" ? "buy" : "sell",
        cfg.respProofLots,
        cfg.respProofRatio,
      );
    }
    // optional no-give-back confirmation before the entry bar
    let at = i;
    let held = true;
    for (let h = 1; h <= cfg.holdBars && held; h++) {
      const hm = minutes[i + h];
      if (
        !hm ||
        (w.dir === "long" ? hm.low < minutes[i].low - cfg.holdTolPts : hm.high > minutes[i].high + cfg.holdTolPts)
      ) {
        held = false;
      } else {
        at = i + h;
      }
    }
    if (!held) return { fired: null, done: true }; // broke through then gave back — sequence over
    // a risk-floor / filter rejection is NOT sequence death: a later bar in
    // the window can still fire (its stop sits differently)
    return { fired: emit(i, w, at, out.length), done: false };
  };

  for (let i = 1; i < n; i++) {
    // the running extremes only see COMPLETED bars
    sessHi = Math.max(sessHi, minutes[i - 1].high);
    sessLo = Math.min(sessLo, minutes[i - 1].low);

    if (i - lastSignalIdx < cfg.minGapBars) continue;

    // ---- long watch ----
    if (!longWatch) {
      longWatch = startLong(i);
      if (longWatch && cfg.fireAt === "flush") {
        const sig = emit(i, longWatch, i, out.length);
        if (sig) {
          out.push(sig);
          lastSignalIdx = i;
        }
        longWatch = null;
        continue;
      }
    } else if (longWatch.respIdx < 0 && cfg.needResponse) {
      if (i - longWatch.flushIdx <= cfg.respWindow) {
        if (tryResponse(i, longWatch) && cfg.fireAt === "response") {
          const sig = emit(i, longWatch, i, out.length);
          if (sig) {
            out.push(sig);
            lastSignalIdx = i;
          }
          longWatch = null;
          continue;
        }
      } else {
        longWatch = null;
      }
    } else {
      // breakout phase — from the response bar, or straight from the flush in
      // merged mode (needResponse = false)
      const base = longWatch.respIdx >= 0 ? longWatch.respIdx : longWatch.flushIdx;
      if (i - base <= cfg.breakWindow) {
        const r = tryBreakout(i, longWatch);
        if (r.fired) {
          out.push(r.fired);
          lastSignalIdx = i;
          longWatch = null;
          continue;
        }
        if (r.done) longWatch = null;
      } else {
        longWatch = null;
      }
    }

    // ---- short watch ----
    if (!shortWatch) {
      shortWatch = startShort(i);
      if (shortWatch && cfg.fireAt === "flush") {
        const sig = emit(i, shortWatch, i, out.length);
        if (sig) {
          out.push(sig);
          lastSignalIdx = i;
        }
        shortWatch = null;
        continue;
      }
    } else if (shortWatch.respIdx < 0 && cfg.needResponse) {
      if (i - shortWatch.flushIdx <= cfg.respWindow) {
        if (tryResponse(i, shortWatch) && cfg.fireAt === "response") {
          const sig = emit(i, shortWatch, i, out.length);
          if (sig) {
            out.push(sig);
            lastSignalIdx = i;
          }
          shortWatch = null;
          continue;
        }
      } else {
        shortWatch = null;
      }
    } else {
      const base = shortWatch.respIdx >= 0 ? shortWatch.respIdx : shortWatch.flushIdx;
      if (i - base <= cfg.breakWindow) {
        const r = tryBreakout(i, shortWatch);
        if (r.fired) {
          out.push(r.fired);
          lastSignalIdx = i;
          shortWatch = null;
          continue;
        }
        if (r.done) shortWatch = null;
      } else {
        shortWatch = null;
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Expansion scalp — the "86% bar" standalone (feature-study lead #1).
 *
 * A HUGE one-sided bar with a direction-matching cluster stack continues
 * next bar 77-86% of the time: fire at its close, stop under its low,
 * 1R target. No flush sequence required — pure candle-size × footprint.
 * ------------------------------------------------------------------ */

export type ExpansionConfig = {
  /** bar range ÷ ATR14 must be at least this (1.6 = "huge") */
  minRangeR: number;
  /** |delta| share of volume (0.5 = the extreme bin) */
  minAbsDeltaFrac: number;
  /** require a dominant cluster stack matching the trade direction */
  requireStack: boolean;
  volFloor: number;
  volMedMult: number;
  volCapAbs: number;
  minRiskPts: number;
  maxRiskPts: number;
  stopPad: number;
  targetR: number;
  minGapBars: number;
  hourFilter: "none" | "globex" | "globexOpen" | "globexCore";
  medWindow: number;
  /** candle POC gates (same as the momentum detector's) */
  requireBreakPoc: boolean;
  requirePocMove: boolean;
  /** session-context gate: "cumDelta" = expansion direction must agree with
   *  the session cumulative-delta sign; "vwap" = entry must sit on the
   *  session-VWAP side of the trade; "both" = both. "none" = off.
   *  (The 22:50 counter-trend short from the 2026-10-02 trade review.) */
  sessionTrend: "none" | "cumDelta" | "vwap" | "both";
  /** veto entries at an exact double top/bottom: a long whose high makes no
   *  new trailing swing high (≤ trailHigh + tol), short mirror. 0 = off.
   *  (The 00:41 double-top long from the 2026-10-02 trade review.) */
  swingVetoTolPts: number;
  /** trailing bars for the swing-extreme veto */
  swingLookback: number;
  /** wider stop pad in the 00:00–02:00 ET window (undefined = off) — the
   *  stop-run study's hour-conditional pad candidate. */
  stopPadNight?: number;
};

export const EXP_DEFAULTS: ExpansionConfig = {
  minRangeR: 1.6,
  minAbsDeltaFrac: 0.5,
  requireStack: true,
  volFloor: 15,
  volMedMult: 0.5,
  volCapAbs: 250,
  minRiskPts: 3,
  maxRiskPts: 15,
  stopPad: 0.5,
  targetR: 1,
  minGapBars: 5,
  hourFilter: "globex",
  medWindow: 60,
  requireBreakPoc: false,
  requirePocMove: false,
  sessionTrend: "none",
  swingVetoTolPts: 0,
  swingLookback: 20,
};

/** The production expansion config — frozen after the 568-session sweeps:
 *  huge bar (≥1.6× ATR14) with ≥75% one-sided delta and a direction-matching
 *  cluster stack, stop under its low, 1R target. Sequential replay: 4,144
 *  trades, 78.4% win, PF 3.14 — combined with the flush trigger: 4,822
 *  trades, 77.5% win, PF 2.98. */
export const EXP_PROD: ExpansionConfig = {
  ...EXP_DEFAULTS,
  hourFilter: "globex",
};

export function detectExpansionScalp(minutes: MomMinute[], cfg: ExpansionConfig = EXP_DEFAULTS): MomentumSignal[] {
  const n = minutes.length;
  const out: MomentumSignal[] = [];
  if (n < 30) return out;

  // session prefixes: vwap + cumulative delta (lookahead-free — the context
  // the vetoes read; also recorded on the signal for feature studies)
  const vwap: number[] = new Array(n);
  const cumD: number[] = new Array(n);
  {
    let vn = 0;
    let vd = 0;
    let cd = 0;
    for (let i = 0; i < n; i++) {
      const m = minutes[i];
      const v = m.buy + m.sell;
      if (v > 0) {
        vn += ((m.high + m.low + closeOf(m)) / 3) * v;
        vd += v;
      }
      vwap[i] = vd > 0 ? vn / vd : 0;
      cd += m.buy - m.sell;
      cumD[i] = cd;
    }
  }
  /** trailing swing high/low over the bars BEFORE i (no lookahead) */
  const trailHiAt = (i: number): number => {
    let hi = -Infinity;
    for (let k = Math.max(0, i - cfg.swingLookback); k < i; k++) hi = Math.max(hi, minutes[k].high);
    return hi;
  };
  const trailLoAt = (i: number): number => {
    let lo = Infinity;
    for (let k = Math.max(0, i - cfg.swingLookback); k < i; k++) lo = Math.min(lo, minutes[k].low);
    return lo;
  };
  const atrAt = (i: number): number => {
    const from = Math.max(0, i - 14);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].high - minutes[k].low);
    return med(arr);
  };
  const medAt = (i: number): number => {
    const from = Math.max(0, i - cfg.medWindow);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].buy + minutes[k].sell);
    return med(arr);
  };
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;

  let lastSignalIdx = -10_000;
  for (let i = 1; i < n; i++) {
    if (i - lastSignalIdx < cfg.minGapBars) continue;
    const m = minutes[i];
    const vol = m.buy + m.sell;
    if (vol < Math.max(cfg.volFloor, Math.min(cfg.volMedMult * medAt(i), cfg.volCapAbs))) continue;
    const range = m.high - m.low;
    if (range / Math.max(0.25, atrAt(i)) < cfg.minRangeR) continue;
    const frac = vol > 0 ? m.buy / vol : 0.5;
    const absD = Math.abs(m.buy - m.sell) / vol;
    if (absD < cfg.minAbsDeltaFrac) continue;
    const dir: "long" | "short" = m.buy > m.sell ? "long" : "short";
    const stack = barStack(m.levels);
    if (cfg.requireStack && stack !== (dir === "long" ? "buy" : "sell")) continue;
    if (rthBlocked(hourET(m.t), Number(m.t.slice(3, 5)), cfg.hourFilter)) continue;
    if (cfg.requireBreakPoc || cfg.requirePocMove) {
      const pocPos = barPocPos(m.levels, range, m.low);
      let pocMove = 0;
      if (i >= 1) {
        const pr = minutes[i - 1];
        const prRange = pr.high - pr.low;
        const prPoc = prRange > 0.25 ? barPocPos(pr.levels, prRange, pr.low) * prRange + pr.low : 0;
        if (prPoc > 0) pocMove = pocPos * range + m.low - prPoc;
      }
      if (cfg.requireBreakPoc && (dir === "long" ? pocPos < 0.5 : pocPos > 0.5)) continue;
      if (cfg.requirePocMove && (dir === "long" ? pocMove <= 0 : pocMove >= 0)) continue;
    }

    // session-context vetoes (the 2026-10-02 trade review's expansion loss
    // classes: counter-trend single huge bars + exact double-top entries)
    if (cfg.sessionTrend === "cumDelta" || cfg.sessionTrend === "both") {
      if (dir === "long" && cumD[i] <= 0) continue;
      if (dir === "short" && cumD[i] >= 0) continue;
    }
    if (cfg.sessionTrend === "vwap" || cfg.sessionTrend === "both") {
      if (dir === "long" && closeOf(m) < vwap[i]) continue;
      if (dir === "short" && closeOf(m) > vwap[i]) continue;
    }
    if (cfg.swingVetoTolPts > 0) {
      if (dir === "long" && m.high <= trailHiAt(i) + cfg.swingVetoTolPts) continue;
      if (dir === "short" && m.low >= trailLoAt(i) - cfg.swingVetoTolPts) continue;
    }

    const entry = closeOf(m);
    const pad = cfg.stopPadNight !== undefined && hourET(m.t) >= 0 && hourET(m.t) < 2 ? cfg.stopPadNight : cfg.stopPad;
    const stop = dir === "long" ? m.low - pad : m.high + pad;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk < cfg.minRiskPts || risk > cfg.maxRiskPts) continue;
    const target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
    lastSignalIdx = i;
    out.push({
      dir,
      kind: "expansion" as const,
      flushIdx: i - 1,
      respIdx: i,
      breakIdx: i,
      entryIdx: i,
      entry,
      stop,
      target,
      risk,
      t: m.t,
      d: m.d,
      hourET: hourET(m.t),
      flushFrac: 0.5,
      flushVol: vol,
      flushRange: range,
      failDepth: 0,
      respFrac: frac,
      respVol: vol,
      respDelay: 1,
      respProof: 0,
      breakFrac: frac,
      breakVol: vol,
      breakDelay: 1,
      refDist: 0,
      progressPts: 0,
      medVol: medAt(i),
      distVwapPts: closeOf(m) - vwap[i],
      cumDelta: cumD[i],
      deltaFromFlush: 0,
      atr14: atrAt(i),
      riskPts: risk,
      trailLowDist: 0,
      trailHighDist: 0,
      breakRangeR: range / Math.max(0.25, atrAt(i)),
      breakStack: stack,
      breakVwapPos: barVwapPos(m.levels, range, m.low),
      flushRangeR: 0,
    });
  }
  return out;
}
