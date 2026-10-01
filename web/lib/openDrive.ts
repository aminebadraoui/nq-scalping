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
  /** "drive" = the strict cumulative-delta drive (rare, highest quality);
   *  "scan" = scan the WHOLE 9:30-9:59 window: first new opening extreme
   *  backed by cumD >= floor and a one-sided bar = the real move (96% hit
   *  at TP10/SL30, 87% of days);
   *  "pullback" = the trader's morning instinct, made objective: trend
   *  (15-bar cumD) + a counter bar that holds the 5-bar low with SHRINKING
   *  counter-delta (exhaustion) + a reclaim bar with the trend — enter at
   *  the reclaim close, stop under the pullback low (69.8% win, +5.2 pts
   *  net per trade in the 9:30-10:30 window);
   *  "daily" = the 9:30 bar's own delta sign (available EVERY day:
   *  TP15/SL35 touches +15 in ~1 bar 79% of sessions, +4.4 pts gross). */
  mode: "drive" | "daily" | "scan" | "pullback";
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
  mode: "drive",
};

/** The experimental production config — the strict direction rule with the
 *  fixed-stop plan from the open excursion study: TP 10 / SL 30 touches the
 *  target within ~1 bar 89% of the time (median adverse excursion ~1 pt,
 *  gross +5.6 pts/trade; ~+5.1 after 0.5 cost). FEED_OPEN defaults OFF —
 *  journal every card separately if enabled. */
export const OPEN_PROD: OpenDriveConfig = {
  ...OPEN_DEFAULTS,
  mode: "scan",
  cumDeltaFloor: 300,
  minBuyFrac: 0.55,
  fixedTpPts: 15,
  fixedSlPts: 35,
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

  if (cfg.mode === "daily") {
    const m = minutes[i0];
    cumD = m.buy - m.sell;
    if (cumD === 0) return out;
    const dir: "long" | "short" = cumD > 0 ? "long" : "short";
    const entry = closeOf(m);
    const stop = dir === "long" ? entry - cfg.fixedSlPts : entry + cfg.fixedSlPts;
    const target = dir === "long" ? entry + cfg.fixedTpPts : entry - cfg.fixedTpPts;
    out.push({
      dir,
      kind: "flush" as const,
      flushIdx: i0,
      respIdx: i0,
      breakIdx: i0,
      entryIdx: i0,
      entry,
      stop,
      target,
      risk: cfg.fixedSlPts,
      t: m.t,
      d: m.d,
      hourET: hourET(m.t),
      flushFrac: 0.5,
      flushVol: m.buy + m.sell,
      flushRange: m.high - m.low,
      failDepth: 0,
      respFrac: m.buy + m.sell > 0 ? m.buy / (m.buy + m.sell) : 0.5,
      respVol: m.buy + m.sell,
      respDelay: 0,
      respProof: 0,
      breakFrac: m.buy + m.sell > 0 ? m.buy / (m.buy + m.sell) : 0.5,
      breakVol: m.buy + m.sell,
      breakDelay: 0,
      refDist: 0,
      progressPts: 0,
      medVol: medVol(i0),
      distVwapPts: 0,
      cumDelta: cumD,
      deltaFromFlush: cumD,
      atr14: atrAt(i0),
      riskPts: cfg.fixedSlPts,
      trailLowDist: 0,
      trailHighDist: 0,
      breakRangeR: (m.high - m.low) / Math.max(0.25, atrAt(i0)),
      breakStack: "none",
      breakVwapPos: 0.5,
      flushRangeR: 0,
    });
    return out;
  }

  if (cfg.mode === "pullback") {
    // 9:30-10:30: trend + exhausted pullback + reclaim (lib/pullbackEntry study)
    const endK = Math.min(n - 1, i0 + 60);
    let lastSignal = i0 - 10;
    for (let k = i0 + 16; k <= endK; k++) {
      if (k - lastSignal < 5) continue;
      // the trend: trailing 15-bar cumulative delta before the current bar
      let D = 0;
      for (let j = Math.max(i0, k - 15); j < k; j++) D += minutes[j].buy - minutes[j].sell;
      if (D === 0) continue;
      const pb = minutes[k - 1];
      const pbD = pb.buy - pb.sell;
      const dir: "long" | "short" = D > 0 ? "long" : "short";
      if (dir === "long" ? pbD >= 0 : pbD <= 0) continue; // last bar must be counter-trend
      // structure held + shrinking counter-aggression
      let lo5 = Infinity;
      let hi5 = -Infinity;
      for (let j = k - 6; j <= k - 2; j++) {
        lo5 = Math.min(lo5, minutes[j].low);
        hi5 = Math.max(hi5, minutes[j].high);
      }
      if (dir === "long" ? pb.low < lo5 - 0.25 : pb.high > hi5 + 0.25) continue;
      const prevD = minutes[k - 2].buy - minutes[k - 2].sell;
      if (Math.abs(pbD) >= Math.abs(prevD)) continue; // exhaustion required
      // trigger: reclaim the pullback with trend-side delta
      const m = minutes[k];
      const mD = m.buy - m.sell;
      if (dir === "long" ? !(closeOf(m) > pb.high && mD > 0) : !(closeOf(m) < pb.low && mD < 0)) continue;
      const entry = closeOf(m);
      const stop = dir === "long" ? pb.low - cfg.stopPad : pb.high + cfg.stopPad;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk > cfg.maxRiskPts) continue;
      const target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
      lastSignal = k;
      out.push({
        dir,
        kind: "flush" as const,
        flushIdx: k - 1,
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
        flushVol: m.buy + m.sell,
        flushRange: m.high - m.low,
        failDepth: 0,
        respFrac: m.buy + m.sell > 0 ? m.buy / (m.buy + m.sell) : 0.5,
        respVol: m.buy + m.sell,
        respDelay: 1,
        respProof: 0,
        breakFrac: m.buy + m.sell > 0 ? m.buy / (m.buy + m.sell) : 0.5,
        breakVol: m.buy + m.sell,
        breakDelay: 1,
        refDist: 0,
        progressPts: 0,
        medVol: medVol(k),
        distVwapPts: 0,
        cumDelta: D,
        deltaFromFlush: D,
        atr14: atrAt(k),
        riskPts: risk,
        trailLowDist: 0,
        trailHighDist: 0,
        breakRangeR: (m.high - m.low) / Math.max(0.25, atrAt(k)),
        breakStack: "none",
        breakVwapPos: 0.5,
        flushRangeR: 0,
      });
    }
    return out;
  }

  if (cfg.mode === "scan") {
    // scan the whole 9:30-9:59 window: the FIRST new opening extreme that
    // cumulative delta and one-sidedness actually back = the real move
    let cumS = 0;
    let winHi = -Infinity;
    let winLo = Infinity;
    for (let k = i0; k < Math.min(n - 1, i0 + cfg.windowMin); k++) {
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      const priorHi = winHi;
      const priorLo = winLo;
      winHi = Math.max(winHi, m.high);
      winLo = Math.min(winLo, m.low);
      cumS += m.buy - m.sell;
      if (k === i0) continue;
      let dir: "long" | "short" | null = null;
      if (m.high > priorHi && priorHi > -Infinity && cumS >= cfg.cumDeltaFloor && frac >= cfg.minBuyFrac) dir = "long";
      else if (m.low < priorLo && priorLo < Infinity && cumS <= -cfg.cumDeltaFloor && frac <= 1 - cfg.minBuyFrac) dir = "short";
      if (!dir) continue;
      const entry = closeOf(m);
      const stop = dir === "long" ? entry - cfg.fixedSlPts : entry + cfg.fixedSlPts;
      const target = dir === "long" ? entry + cfg.fixedTpPts : entry - cfg.fixedTpPts;
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
        risk: cfg.fixedSlPts,
        t: m.t,
        d: m.d,
        hourET: hourET(m.t),
        flushFrac: 0.5,
        flushVol: vol,
        flushRange: m.high - m.low,
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
        cumDelta: cumS,
        deltaFromFlush: cumS,
        atr14: atrAt(k),
        riskPts: cfg.fixedSlPts,
        trailLowDist: 0,
        trailHighDist: 0,
        breakRangeR: (m.high - m.low) / Math.max(0.25, atrAt(k)),
        breakStack: "none",
        breakVwapPos: 0.5,
        flushRangeR: 0,
      });
      return out;
    }
    return out;
  }

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

/** The pullback-entry config — the trader's morning pattern made objective
 *  (trend + exhausted pullback + reclaim). 9:30-10:30 study: 69.8% win at
 *  1R, +5.2 pts net per trade, 440 trades over 568 sessions. */
export const PULLBACK_PROD: OpenDriveConfig = {
  ...OPEN_DEFAULTS,
  mode: "pullback",
  stopPad: 0.5,
  targetR: 1,
  maxRiskPts: 25,
};
