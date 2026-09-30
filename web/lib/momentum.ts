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
  hourFilter: "none" | "globex";
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
};

/** The production momentum config — frozen after the 568-session sweep
 *  (see MOMENTUM_SIGNAL.md): 502 trades, 72.9% win, PF 2.25, positive every
 *  year, ~0.9 signals per session. Tight breakout-bar stop, 75% one-sided
 *  breakout, ≥2 pt risk floor, breakout within 10 bars of the response. */
export const MOM_PROD: MomConfig = {
  ...MOM_DEFAULTS,
  stopMode: "breakout",
  stopPad: 0.5,
  breakFrac: 0.75,
  breakWindow: 10,
  minRiskPts: 2,
  targetR: 1,
  hourFilter: "globex",
};

export type MomentumSignal = {
  dir: "long" | "short";
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
  /** flush vs the trailing 20-bar low/high — the local context of the probe */
  trailLowDist: number;
  trailHighDist: number;
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
    if (m.low < sessLo - cfg.failTolPts) return null; // real breakdown — not ours
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
    if (m.high > sessHi + cfg.failTolPts) return null; // real breakout up — not ours
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
    const stop =
      cfg.stopMode === "breakout" && cfg.fireAt === "breakout"
        ? dir === "long"
          ? bk.low - cfg.stopPad
          : bk.high + cfg.stopPad
        : dir === "long"
          ? w.flushLow - cfg.stopPad
          : w.flushHigh + cfg.stopPad;
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
    if (cfg.hourFilter === "globex") {
      const hh = hourET(entryBar.t);
      const mm = Number(entryBar.t.slice(3, 5));
      const rth = (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
      if (rth) return null;
    }
    if (cfg.deltaConfirm) {
      const d = cumD[at] - cumD[w.flushIdx];
      if (dir === "long" && d <= 0) return null;
      if (dir === "short" && d >= 0) return null;
    }
    const target = dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;
    const flushBar = minutes[w.flushIdx];
    const respBar = minutes[w.respIdx];
    return {
      dir,
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
    } satisfies MomentumSignal;
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
    } else if (longWatch.respIdx < 0) {
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
      const m = minutes[i];
      const frac = fracOf(m);
      if (i - longWatch.respIdx <= cfg.breakWindow) {
        if (
          frac >= cfg.breakFrac &&
          volOk(m.buy + m.sell, medAt(i), cfg.breakVolFloor, cfg.breakVolMedMult) &&
          m.high > longWatch.refHigh
        ) {
          // optional no-give-back confirmation before the entry bar
          let at = i;
          let held = true;
          for (let h = 1; h <= cfg.holdBars && held; h++) {
            const hm = minutes[i + h];
            if (!hm || hm.low < minutes[i].low - cfg.holdTolPts) held = false;
            else at = i + h;
          }
          if (held) {
            const sig = emit(i, longWatch, at, out.length);
            if (sig) {
              out.push(sig);
              lastSignalIdx = i;
            }
            longWatch = null;
            continue;
          }
          longWatch = null;
        }
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
    } else if (shortWatch.respIdx < 0) {
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
      const m = minutes[i];
      const frac = fracOf(m);
      if (i - shortWatch.respIdx <= cfg.breakWindow) {
        if (
          frac <= 1 - cfg.breakFrac &&
          volOk(m.buy + m.sell, medAt(i), cfg.breakVolFloor, cfg.breakVolMedMult) &&
          m.low < shortWatch.refLow
        ) {
          let at = i;
          let held = true;
          for (let h = 1; h <= cfg.holdBars && held; h++) {
            const hm = minutes[i + h];
            if (!hm || hm.high > minutes[i].high + cfg.holdTolPts) held = false;
            else at = i + h;
          }
          if (held) {
            const sig = emit(i, shortWatch, at, out.length);
            if (sig) {
              out.push(sig);
              lastSignalIdx = i;
            }
            shortWatch = null;
            continue;
          }
          shortWatch = null;
        }
      } else {
        shortWatch = null;
      }
    }
  }

  return out;
}
