/* ------------------------------------------------------------------ *
 * Honest fill model — the one place backtests decide what price a trade
 * could ACTUALLY have been filled at.  (2026-10-26)
 *
 * Why this exists: the session archive is footprint-only (high / low /
 * buy / sell / levels — no open, no close). Every legacy scorer entered at
 * the signal bar's MIDPOINT, but the first price the live system can trade
 * is the NEXT bar's open, and after a strong one-sided bar that open sits
 * near the bar's extreme, not its middle. Measured on the 27 sessions that
 * have vendor OHLC twins (37,135 bar pairs, archive H/L match the twin
 * 99.95%):
 *
 *   next open, as a fraction of the signal bar's range (0 = low, 1 = high)
 *   buy share of the bar   p20   p50   p80   p90
 *   < 0.30                 0.05  0.23  0.55  0.75
 *   0.30–0.40              0.08  0.26  0.57  0.77
 *   0.40–0.60              0.19  0.51  0.82  0.92
 *   0.60–0.70              0.43  0.73  0.91  0.97
 *   ≥ 0.70                 0.50  0.77  0.94  1.00   (mirror-symmetric for sells)
 *
 * A long fired on a ≥70%-buy bar therefore fills (median) ~a quarter of
 * the bar's range above the mid the old backtests used — on a 9-pt bar that is the
 * whole edge of a 3.5-pt-stop, 1R-target scalp.
 *
 * Rules (all pessimistic where the minute bar cannot tell the order of
 * events):
 *   MARKET entry  next bar's open: the true open when an OHLC twin is
 *                 joined (bar.c > 0 → the signal bar's close), otherwise the
 *                 CONSERVATIVE p80 estimate above (default), plus
 *                 `slipPts` against the trade. Why not the median: over ALL
 *                 bars the p50 estimate is unbiased (+0.07 pt), but a
 *                 strategy SELECTS bars, and the selection leaks into the
 *                 residual — on the 27 twin sessions p50 was optimistic by
 *                 0.42 pt for strong-flow bars and by 1.3 pt (4.6 pt in RTH)
 *                 for new-session-extreme fades, i.e. it manufactured that
 *                 fade's whole "edge". p80 stayed pessimistic for both
 *                 (+2.3 / +2.5 pt, optimistic in only ~25% of signals).
 *                 `marketQuantile: "p50"` is available as the OPTIMISTIC
 *                 bound; a market-entry result is only credible if it
 *                 survives p80 AND, where possible, the twin sessions.
 *   LIMIT entry   fills only when price TRADES THROUGH the limit by one
 *                 tick (touch ≠ fill: the queue) within the TTL.
 *   STOP entry    fills when price reaches the trigger, at trigger +
 *                 `slipPts` (or the bar's open-side extreme on a gap).
 *   FILL BAR      for limit / stop entries the fill bar's own range is
 *                 checked for the STOP (stop-first) and never credits the
 *                 TARGET (we cannot know the fill came first).
 *   STOP exit     stop ∓ `slipPts`.
 *   TARGET exit   needs a trade-through by one tick.
 *   SAME BAR      stop and target both inside one bar → stop.
 *   TIME exit     the exit bar's median-close estimate ∓ `slipPts`.
 *   FEES          `feePts` per round trip per contract (MNQ: $1.90 RT /
 *                 $2 per pt = 0.95 pt).
 * ------------------------------------------------------------------ */

export const TICK = 0.25;
/** MNQ round-trip commission in points ($1.90 / $2 per point) */
export const MNQ_FEE_PTS = 0.95;
export const DEFAULT_SLIP_PTS = 0.25;

export type FillBar = {
  high: number;
  low: number;
  /** true close when an OHLC twin is joined, else 0 */
  c?: number;
  /** true open when an OHLC twin is joined, else 0 */
  o?: number;
  buy?: number;
  sell?: number;
};

const P80 = [0.55, 0.57, 0.82, 0.91, 0.94];
const P50 = [0.23, 0.26, 0.51, 0.73, 0.77];

function bucket(share: number): number {
  if (share < 0.3) return 0;
  if (share < 0.4) return 1;
  if (share < 0.6) return 2;
  if (share < 0.7) return 3;
  return 4;
}

/** share of the bar's volume on `side` (0.5 when the bar has no flow) */
function sideShare(b: FillBar, side: 1 | -1): number {
  const buy = b.buy ?? 0;
  const sell = b.sell ?? 0;
  const tot = buy + sell;
  if (!(tot > 0)) return 0.5;
  return side > 0 ? buy / tot : sell / tot;
}

const roundTick = (p: number): number => Math.round(p / TICK) * TICK;

export type MarketQuantile = "p50" | "p80";

/** Estimate of the price a MARKET order sent at the close of `signal`
 *  fills at (the next bar's open), for a trade in direction `dir`: the
 *  conservative p80 by default, `"p50"` for the optimistic bound.
 *  Uses the true close when the bar carries one. Slippage NOT included. */
export function marketFillEstimate(signal: FillBar, dir: 1 | -1, q: MarketQuantile = "p80"): number {
  if ((signal.c ?? 0) > 0) return signal.c as number;
  const range = signal.high - signal.low;
  const tab = q === "p80" ? P80 : P50;
  const qv = tab[bucket(sideShare(signal, dir))];
  return roundTick(dir > 0 ? signal.low + qv * range : signal.high - qv * range);
}

/** Median estimate of where a bar closed (for time exits). Uses the true
 *  close when present. */
export function closeEstimate(b: FillBar): number {
  if ((b.c ?? 0) > 0) return b.c as number;
  const range = b.high - b.low;
  return roundTick(b.low + P50[bucket(sideShare(b, 1))] * range);
}

export type EntryOrder =
  | { kind: "market" }
  | { kind: "limit"; price: number; ttlBars: number }
  | { kind: "stop"; price: number; ttlBars: number };

export type HonestSpec = {
  dir: 1 | -1;
  /** index of the bar whose close generated the signal (nothing at or
   *  before it can be traded) */
  signalIdx: number;
  entry: EntryOrder;
  /** bracket distances in points, anchored at the FILL price (the live
   *  brackets are rebuilt from the fill) — or absolute prices */
  stopPts?: number;
  targetPts?: number;
  stopPrice?: number;
  targetPrice?: number;
  /** time exit: bars after the fill bar (default 60) */
  holdBars?: number;
};

export type HonestOpts = {
  slipPts?: number;
  /** market-entry estimate when no true open exists (default p80, conservative) */
  marketQuantile?: MarketQuantile;
  feePts?: number;
};

export type HonestResult = {
  filled: boolean;
  fillIdx: number;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  exitIdx: number;
  hit: "target" | "stop" | "time" | "nofill";
  /** points before fees */
  grossPts: number;
  /** points after fees (= gross − feePts) */
  netPts: number;
  risk: number;
  heldBars: number;
  mfePts: number;
  maePts: number;
};

const NOFILL = (spec: HonestSpec): HonestResult => ({
  filled: false,
  fillIdx: -1,
  entry: NaN,
  stop: NaN,
  target: NaN,
  exit: NaN,
  exitIdx: -1,
  hit: "nofill",
  grossPts: 0,
  netPts: 0,
  risk: spec.stopPts ?? NaN,
  heldBars: 0,
  mfePts: 0,
  maePts: 0,
});

/** Simulate one trade with the honest rules above. Returns `null` when the
 *  bracket is invalid at the fill (target or stop already on the wrong
 *  side of the fill price — the broker would reject the order). */
export function simulateHonest(bars: readonly FillBar[], spec: HonestSpec, opts?: HonestOpts): HonestResult | null {
  const slip = opts?.slipPts ?? DEFAULT_SLIP_PTS;
  const fee = opts?.feePts ?? MNQ_FEE_PTS;
  const dir = spec.dir;
  const sig = bars[spec.signalIdx];
  if (!sig) return null;
  const first = spec.signalIdx + 1;
  if (first >= bars.length) return NOFILL(spec);

  /* ---- 1. the fill ---- */
  let fillIdx = -1;
  let entry = NaN;
  let fillBarIsAfter = false; // true = the fill happened at the bar's open (market): the whole bar is post-fill
  const o = spec.entry;
  if (o.kind === "market") {
    fillIdx = first;
    const nb = bars[first];
    const open = (nb.o ?? 0) > 0 ? (nb.o as number) : marketFillEstimate(sig, dir, opts?.marketQuantile);
    entry = open + dir * slip;
    fillBarIsAfter = true;
  } else {
    const last = Math.min(bars.length - 1, spec.signalIdx + o.ttlBars);
    for (let j = first; j <= last; j++) {
      const b = bars[j];
      if (o.kind === "limit") {
        const through = dir > 0 ? b.low <= o.price - TICK : b.high >= o.price + TICK;
        if (through) {
          fillIdx = j;
          entry = o.price;
          break;
        }
      } else {
        const trig = dir > 0 ? b.high >= o.price : b.low <= o.price;
        if (trig) {
          fillIdx = j;
          // a bar that traded entirely beyond the trigger (a gap) fills no
          // better than its own nearest extreme
          const base = dir > 0 ? Math.max(o.price, b.low) : Math.min(o.price, b.high);
          entry = base + dir * slip;
          break;
        }
      }
    }
    if (fillIdx < 0) return NOFILL(spec);
  }

  /* ---- 2. the bracket, rebuilt from the fill ---- */
  const stop = spec.stopPrice ?? entry - dir * (spec.stopPts ?? NaN);
  const target = spec.targetPrice ?? entry + dir * (spec.targetPts ?? NaN);
  if (![stop, target].every(Number.isFinite)) return null;
  if (dir > 0 && !(stop < entry && entry < target)) return null;
  if (dir < 0 && !(target < entry && entry < stop)) return null;
  const risk = Math.abs(entry - stop);

  /* ---- 3. the walk ---- */
  const hold = spec.holdBars ?? 60;
  const end = Math.min(bars.length - 1, fillIdx + hold);
  let mfe = 0;
  let mae = 0;
  let hit: HonestResult["hit"] = "time";
  let exit = NaN;
  let exitIdx = end;
  for (let j = fillIdx; j <= end; j++) {
    const b = bars[j];
    const isFillBar = j === fillIdx;
    const fav = dir > 0 ? b.high - entry : entry - b.low;
    const adv = dir > 0 ? entry - b.low : b.high - entry;
    // excursions on the fill bar are only knowable for a market fill
    if (!isFillBar || fillBarIsAfter) {
      mfe = Math.max(mfe, fav);
      mae = Math.max(mae, adv);
    }
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target + TICK : b.low <= target - TICK;
    if (stopHit) {
      hit = "stop";
      exit = stop - dir * slip;
      exitIdx = j;
      break;
    }
    // a limit/stop fill bar never credits the target: the order of the
    // fill and the target touch inside one minute is unknown
    if (tgtHit && (!isFillBar || fillBarIsAfter)) {
      hit = "target";
      exit = target;
      exitIdx = j;
      break;
    }
  }
  if (hit === "time") {
    // time exit at the close of `end` (≈ next open), against the trade
    exit = closeEstimate(bars[end]) - dir * slip;
    exitIdx = end;
  }
  const grossPts = (exit - entry) * dir;
  return {
    filled: true,
    fillIdx,
    entry,
    stop,
    target,
    exit,
    exitIdx,
    hit,
    grossPts,
    netPts: grossPts - fee,
    risk,
    heldBars: exitIdx - fillIdx,
    mfePts: mfe,
    maePts: mae,
  };
}
