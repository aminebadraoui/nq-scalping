/* ------------------------------------------------------------------ *
 * Opening-drive detector — a dedicated 9:30 open strategy.
 *
 * The open is the opposite of the Globex tape: huge bars, fast two-way
 * volume, low per-bar one-sidedness. So instead of one-sidedness the
 * signal leans on CUMULATIVE delta from the bell (the open's direction
 * as a sum, not a single bar) plus a breakout of the running opening
 * extreme on a massive bar, closing through the level.
 *
 * One signal per day, by construction. Same ticket mechanics as the
 * momentum card: entry at the bar's close, stop under its low, 1R.
 * ------------------------------------------------------------------ */

import { closeOf, type MomMinute, type MomentumSignal } from "./momentum";

export type OpenDriveConfig = {
  /** cumulative delta from 9:30 must exceed this (contracts, signed) */
  cumDeltaFloor: number;
  /** per-bar one-sidedness floor — deliberately LOWER than the Globex gates
   *  (open bars are two-way; direction lives in the cumulative delta) */
  minBuyFrac: number;
  /** bar volume vs the trailing overnight median */
  volMedMult: number;
  /** bar range vs ATR14 (open bars are huge) */
  minRangeR: number;
  minRiskPts: number;
  maxRiskPts: number;
  stopPad: number;
  targetR: number;
  /** minutes after the 9:30 bar the drive window stays open */
  windowMin: number;
  /** "close" = the bar must CLOSE through the opening extreme; "high" =
   *  a trade-through is enough (entry still at the close) */
  entryMode: "close" | "high";
  /** fixed stop/target distances (pts). 0 = the 1R mechanics. The open
   *  excursion study: TP10/SL30 hits 89% in ~1 bar with +5.6 pts
   *  expectancy under the strict direction rule. */
  fixedTpPts: number;
  fixedSlPts: number;
};

export const OPEN_DEFAULTS: OpenDriveConfig = {
  cumDeltaFloor: 500,
  minBuyFrac: 0.55,
  volMedMult: 2.0,
  minRangeR: 2.0,
  minRiskPts: 3,
  maxRiskPts: 12,
  stopPad: 0.5,
  targetR: 1,
  windowMin: 30,
  entryMode: "close",
  fixedTpPts: 0,
  fixedSlPts: 0,
};

/** The experimental production config — the strict direction rule with the
 *  fixed-stop plan from the open excursion study: TP 10 / SL 30 touches the
 *  target within ~1 bar 89% of the time (median adverse excursion ~1 pt,
 *  gross +5.6 pts/trade; ~+5.1 after 0.5 cost). FEED_OPEN defaults OFF —
 *  journal every card separately if enabled. */
export const OPEN_PROD: OpenDriveConfig = {
  ...OPEN_DEFAULTS,
  cumDeltaFloor: 300,
  minBuyFrac: 0.5,
  fixedTpPts: 10,
  fixedSlPts: 30,
};

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function detectOpenDrive(minutes: MomMinute[], cfg: OpenDriveConfig = OPEN_DEFAULTS): MomentumSignal[] {
  const n = minutes.length;
  const out: MomentumSignal[] = [];
  if (n < 60) return out;

  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));

  // the 9:30 bar index (feed clock 8:30)
  let i0 = -1;
  for (let i = 0; i < n; i++) {
    if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) {
      i0 = i;
      break;
    }
  }
  if (i0 < 0 || i0 + 3 >= n) return out;

  const medVol = (i: number): number => {
    const from = Math.max(0, i - 60);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].buy + minutes[k].sell);
    return med(arr);
  };
  const atrAt = (i: number): number => {
    const from = Math.max(0, i - 14);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].high - minutes[k].low);
    return med(arr);
  };

  let fired = false;
  let cumD = 0;
  let openHi = -Infinity;
  let openLo = Infinity;

  for (let k = i0; k < Math.min(n - 1, i0 + cfg.windowMin); k++) {
    const m = minutes[k];
    const vol = m.buy + m.sell;
    const range = m.high - m.low;
    const frac = vol > 0 ? m.buy / vol : 0.5;

    // the running opening extremes only see COMPLETED bars
    if (k > i0) {
      openHi = Math.max(openHi, minutes[k - 1].high);
      openLo = Math.min(openLo, minutes[k - 1].low);
    }
    cumD += m.buy - m.sell;
    if (fired) continue;

    const huge = vol >= Math.max(100, cfg.volMedMult * Math.max(1, medVol(k)));
    const bigRange = range / Math.max(0.25, atrAt(k)) >= cfg.minRangeR;
    if (!huge || !bigRange) continue;

    let dir: "long" | "short" | null = null;
    const thruHi = cfg.entryMode === "close" ? closeOf(m) > openHi : m.high > openHi;
    const thruLo = cfg.entryMode === "close" ? closeOf(m) < openLo : m.low < openLo;
    if (cumD >= cfg.cumDeltaFloor && frac >= cfg.minBuyFrac && thruHi && openHi > -Infinity) dir = "long";
    else if (cumD <= -cfg.cumDeltaFloor && frac <= 1 - cfg.minBuyFrac && thruLo && openLo < Infinity) dir = "short";
    if (!dir) continue;

    const entry = closeOf(m);
    let stop: number;
    let target: number;
    let risk: number;
    if (cfg.fixedSlPts > 0) {
      // fixed-stop plan (the open excursion study): wide stop, small TP,
      // tiny size — the 89%-in-one-bar plan
      stop = dir === "long" ? entry - cfg.fixedSlPts : entry + cfg.fixedSlPts;
      target = dir === "long" ? entry + cfg.fixedTpPts : entry - cfg.fixedTpPts;
      risk = cfg.fixedSlPts;
    } else {
      stop = dir === "long" ? m.low - cfg.stopPad : m.high + cfg.stopPad;
      risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk < cfg.minRiskPts || risk > cfg.maxRiskPts) continue;
      target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
    }

    fired = true;
    out.push({
      dir,
      kind: "flush" as const,
      flushIdx: i0,
      respIdx: k,
      breakIdx: k,
      entryIdx: k,
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
      respDelay: 0,
      respProof: 0,
      breakFrac: frac,
      breakVol: vol,
      breakDelay: 0,
      refDist: 0,
      progressPts: 0,
      medVol: medVol(k),
      distVwapPts: 0,
      cumDelta: cumD,
      deltaFromFlush: cumD,
      atr14: atrAt(k),
      riskPts: risk,
      trailLowDist: 0,
      trailHighDist: 0,
      breakRangeR: range / Math.max(0.25, atrAt(k)),
      breakStack: "none",
      breakVwapPos: 0.5,
      flushRangeR: 0,
    });
  }
  return out;
}
