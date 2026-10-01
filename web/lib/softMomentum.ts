/* ------------------------------------------------------------------ *
 * RTH soft-continuation — the strategy the thick two-way RTH tape
 * actually rewards. The Globex gates (≥75% one-sided) never complete in
 * RTH; at 60% one-sidedness the continuation edge reappears:
 * 3,815 longs + 3,937 shorts over 568 sessions, 69.4% / 67.1% win,
 * +2.60 / +2.29 pts net per trade at 1R.
 *
 *   bar in RTH (9:30-16:00 ET), buy-frac ≥ 0.60 (mirror ≤ 0.40),
 *   volume ≥ 0.5 × trailing 60-bar median → enter at the close,
 *   stop under the bar (1 pt pad), 1R target, risk ≤ 15, gap ≥ 5.
 * ------------------------------------------------------------------ */

import { closeOf, type MomMinute, type MomentumSignal } from "./momentum";

export type SoftConfig = {
  minBuyFrac: number;
  volMedMult: number;
  stopPad: number;
  minRiskPts: number;
  maxRiskPts: number;
  targetR: number;
  minGapBars: number;
};

export const SOFT_DEFAULTS: SoftConfig = {
  minBuyFrac: 0.6,
  volMedMult: 0.5,
  stopPad: 1.0,
  minRiskPts: 3,
  maxRiskPts: 15,
  targetR: 1,
  minGapBars: 5,
};

/** The production RTH config — frozen after the 568-session study. */
export const SOFT_PROD: SoftConfig = { ...SOFT_DEFAULTS };

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
export const inRTH = (t: string): boolean => {
  const h = hourET(t);
  const mm = mmOf(t);
  return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

export function detectSoftMomentum(minutes: MomMinute[], cfg: SoftConfig = SOFT_DEFAULTS): MomentumSignal[] {
  const n = minutes.length;
  const out: MomentumSignal[] = [];
  if (n < 30) return out;

  let lastSignal = -10_000;
  for (let k = 20; k < n; k++) {
    if (!inRTH(minutes[k].t)) continue;
    if (k - lastSignal < cfg.minGapBars) continue;
    const m = minutes[k];
    const vol = m.buy + m.sell;
    const arr: number[] = [];
    for (let j = Math.max(0, k - 60); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
    const mv = med(arr);
    if (vol < cfg.volMedMult * mv) continue;
    const frac = vol > 0 ? m.buy / vol : 0.5;
    let dir: "long" | "short" | null = null;
    if (frac >= cfg.minBuyFrac) dir = "long";
    else if (frac <= 1 - cfg.minBuyFrac) dir = "short";
    if (!dir) continue;
    const entry = closeOf(m);
    const stop = dir === "long" ? m.low - cfg.stopPad : m.high + cfg.stopPad;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk < cfg.minRiskPts || risk > cfg.maxRiskPts) continue;
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
      flushVol: vol,
      flushRange: m.high - m.low,
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
      medVol: mv,
      distVwapPts: 0,
      cumDelta: m.buy - m.sell,
      deltaFromFlush: m.buy - m.sell,
      atr14: med(minutes.slice(Math.max(0, k - 14), k).map((x) => x.high - x.low)),
      riskPts: risk,
      trailLowDist: 0,
      trailHighDist: 0,
      breakRangeR: (m.high - m.low) / Math.max(0.25, med(minutes.slice(Math.max(0, k - 14), k).map((x) => x.high - x.low))),
      breakStack: "none",
      breakVwapPos: 0.5,
      flushRangeR: 0,
    });
  }
  return out;
}
