/* ------------------------------------------------------------------ *
 * Failed balance breakout — Pulcini's "best position trade in trading".
 *
 * A balance area forms (the trailing balBars window). Price breaks out
 * beyond its edge, then fails and comes back through the balance's POC —
 * all the longs who bought the breakout are trapped and puke. The fade
 * enters on the bar that closes back through the threshold, stops beyond
 * the breakout excursion (the trapped stops), and targets 1R or the
 * opposite balance edge.
 *
 * Lookahead-free: the balance (high/low/POC) is computed from the bars
 * BEFORE the breakout bar; the POC is the most-traded price across the
 * window's per-price levels.
 *
 * dir is the TRADE direction: an up-breakout that fails back through the
 * threshold is faded SHORT (trapped longs puke), a failed down-breakout is
 * faded LONG. Mirror images throughout.
 * ------------------------------------------------------------------ */

import { closeOf, type MomMinute } from "./momentum";

export type BalanceBreakConfig = {
  /** balance window (bars) before the breakout bar */
  balBars: number;
  /** breakout must exceed the balance edge by this much (pts) */
  breakTolPts: number;
  /** bars allowed for the failure after the breakout */
  failWindow: number;
  /** where the failure is proven: "inside" = back inside the balance edge,
   *  "mid" = through the balance midpoint, "poc" = through the HVN/POC */
  failMode: "inside" | "mid" | "poc";
  /** min counter-side share of the failure bar's volume (0 = off) — the
   *  puke proof */
  failOneSided: number;
  stopPad: number;
  targetMode: "1R" | "edge";
  /** R-multiple target when targetMode = "1R" */
  targetR: number;
  maxRiskPts: number;
  minRiskPts: number;
  minGapBars: number;
  hourFilter: "none" | "globex";
};

export const BALANCE_BREAK_DEFAULTS: BalanceBreakConfig = {
  balBars: 60,
  breakTolPts: 0.25,
  failWindow: 10,
  failMode: "poc",
  failOneSided: 0,
  stopPad: 0.5,
  targetMode: "1R",
  targetR: 1,
  maxRiskPts: 40,
  minRiskPts: 2,
  minGapBars: 5,
  hourFilter: "none",
};

export type BalanceBreakSignal = {
  dir: "long" | "short";
  /** the balance window's extremes as of the breakout bar */
  balHi: number;
  balLo: number;
  balPoc: number;
  /** the breakout excursion extreme (the trapped stops) */
  excursion: number;
  breakIdx: number;
  failIdx: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  t: string;
  d: string;
  hourET: number;
  /** counter-side share of the failure bar (0..1) */
  failBuyPct: number;
};

function hourET(t: string): number {
  return (Number(t.slice(0, 2)) + 1) % 24;
}

function rthBlocked(hh: number, mm: number, filter: "none" | "globex"): boolean {
  if (filter === "none") return false;
  return (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
}

function fracOf(m: MomMinute): number {
  const v = m.buy + m.sell;
  return v > 0 ? m.buy / v : 0.5;
}

export type Balance = { hi: number; lo: number; poc: number; mid: number };

/** balance from the balBars bars ending at endIdx (exclusive) */
export function balanceOf(minutes: MomMinute[], endIdx: number, balBars: number): Balance | null {
  const from = Math.max(0, endIdx - balBars);
  if (endIdx - from < 10) return null;
  let hi = -Infinity;
  let lo = Infinity;
  const volAt = new Map<number, number>();
  for (let k = from; k < endIdx; k++) {
    const m = minutes[k];
    hi = Math.max(hi, m.high);
    lo = Math.min(lo, m.low);
    for (const l of m.levels) {
      volAt.set(l.price, (volAt.get(l.price) ?? 0) + l.buy + l.sell);
    }
  }
  let poc = (hi + lo) / 2;
  let pocVol = -1;
  for (const [p, v] of volAt) {
    if (v > pocVol) {
      pocVol = v;
      poc = p;
    }
  }
  return { hi, lo, poc, mid: (hi + lo) / 2 };
}

/** precompute the rolling balance for every bar (lookahead-free, sliding
 *  volume map) — one pass per window size, shared by all study variants */
export function precomputeBalances(minutes: MomMinute[], balBars: number): (Balance | null)[] {
  const n = minutes.length;
  const out: (Balance | null)[] = new Array(n).fill(null);
  if (n < balBars + 5) return out;

  const volAt = new Map<number, number>();
  let hi = -Infinity;
  let lo = Infinity;

  const addBar = (m: MomMinute) => {
    hi = Math.max(hi, m.high);
    lo = Math.min(lo, m.low);
    for (const l of m.levels) {
      volAt.set(l.price, (volAt.get(l.price) ?? 0) + l.buy + l.sell);
    }
  };
  const removeBar = (m: MomMinute) => {
    for (const l of m.levels) {
      const v = (volAt.get(l.price) ?? 0) - l.buy - l.sell;
      if (v <= 0) volAt.delete(l.price);
      else volAt.set(l.price, v);
    }
    // extremes are recomputed lazily on demand (window is small)
  };
  const recomputeExtremes = (from: number, endIdx: number) => {
    hi = -Infinity;
    lo = Infinity;
    for (let k = from; k < endIdx; k++) {
      hi = Math.max(hi, minutes[k].high);
      lo = Math.min(lo, minutes[k].low);
    }
  };
  const pocOf = (): number => {
    let poc = (hi + lo) / 2;
    let pocVol = -1;
    for (const [p, v] of volAt) {
      if (v > pocVol) {
        pocVol = v;
        poc = p;
      }
    }
    return poc;
  };

  for (let i = balBars + 1; i < n; i++) {
    const from = i - balBars;
    if (i === balBars + 1) {
      for (let k = from; k < i; k++) addBar(minutes[k]);
    } else {
      removeBar(minutes[from - 1]);
      addBar(minutes[i - 1]);
      recomputeExtremes(from, i);
    }
    out[i] = { hi, lo, poc: pocOf(), mid: (hi + lo) / 2 };
  }
  return out;
}

export function detectBalanceBreak(
  minutes: MomMinute[],
  cfg: BalanceBreakConfig = BALANCE_BREAK_DEFAULTS,
): BalanceBreakSignal[] {
  return detectBalanceBreakPre(minutes, precomputeBalances(minutes, cfg.balBars), cfg);
}

/** detection against a precomputed balance array (the study precomputes
 *  once per window size and shares it across variants) */
export function detectBalanceBreakPre(
  minutes: MomMinute[],
  balances: (Balance | null)[],
  cfg: BalanceBreakConfig = BALANCE_BREAK_DEFAULTS,
): BalanceBreakSignal[] {
  const n = minutes.length;
  const out: BalanceBreakSignal[] = [];
  if (n < cfg.balBars + 5) return out;

  let lastEntry = -10_000;

  type Watch = {
    dir: "long" | "short";
    bal: Balance;
    breakIdx: number;
    excursion: number;
  };
  let watch: Watch | null = null;

  for (let i = cfg.balBars + 1; i < n; i++) {
    if (watch) {
      // running excursion extreme (the trapped stops move with the probe).
      // dir is the TRADE direction: a short fades a failed up-break (stop
      // above the excursion high); a long fades a failed down-break (stop
      // below the excursion low).
      watch.excursion =
        watch.dir === "short"
          ? Math.max(watch.excursion, minutes[i].high)
          : Math.min(watch.excursion, minutes[i].low);
      const thr =
        cfg.failMode === "inside"
          ? watch.bal.hi
          : cfg.failMode === "mid"
            ? watch.bal.mid
            : watch.bal.poc;
      const failed =
        watch.dir === "short" ? closeOf(minutes[i]) < thr : closeOf(minutes[i]) > thr;
      const tooLate = i - watch.breakIdx > cfg.failWindow;
      if (tooLate) {
        watch = null;
      } else if (failed) {
        const bp = fracOf(minutes[i]);
        const oneSidedOk =
          cfg.failOneSided <= 0 ||
          (watch.dir === "short" ? bp <= 1 - cfg.failOneSided : bp >= cfg.failOneSided);
        if (oneSidedOk) {
          const entry = closeOf(minutes[i]);
          const stop =
            watch.dir === "short" ? watch.excursion + cfg.stopPad : watch.excursion - cfg.stopPad;
          const risk = watch.dir === "short" ? stop - entry : entry - stop;
          if (risk >= cfg.minRiskPts && risk <= cfg.maxRiskPts && i - lastEntry >= cfg.minGapBars) {
            const et = hourET(minutes[i].t);
            const [hh, mm] = minutes[i].t.split(":").map(Number);
            if (!rthBlocked(hh, mm, cfg.hourFilter)) {
              lastEntry = i;
              out.push({
                dir: watch.dir,
                balHi: watch.bal.hi,
                balLo: watch.bal.lo,
                balPoc: watch.bal.poc,
                excursion: watch.excursion,
                breakIdx: watch.breakIdx,
                failIdx: i,
                entry,
                stop,
                target:
                  cfg.targetMode === "1R"
                    ? watch.dir === "short"
                      ? entry - cfg.targetR * risk
                      : entry + cfg.targetR * risk
                    : watch.dir === "short"
                      ? watch.bal.lo
                      : watch.bal.hi,
                risk,
                t: minutes[i].t,
                d: minutes[i].d,
                hourET: et,
                failBuyPct: bp,
              });
            }
          }
        }
        watch = null;
      } else {
        continue;
      }
    }

    if (i - lastEntry < cfg.minGapBars) continue;

    const bal = balances[i];
    if (!bal) continue;

    // up-breakout → fade SHORT; down-breakout → fade LONG
    if (minutes[i].high > bal.hi + cfg.breakTolPts) {
      watch = { dir: "short", bal, breakIdx: i, excursion: minutes[i].high };
    } else if (minutes[i].low < bal.lo - cfg.breakTolPts) {
      watch = { dir: "long", bal, breakIdx: i, excursion: minutes[i].low };
    }
  }
  return out;
}
