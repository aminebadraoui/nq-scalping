/* ------------------------------------------------------------------ *
 * Signal outcome scorer — did a recorded signal win or lose?
 *
 * Deterministic price-replay scoring, the SAME first-touch rules the
 * backtest engine uses (lib/backtest.ts scoreFire):
 *   · entry = the close of the signal's own bar (the walk starts on the
 *     NEXT bar, exactly like a filled trade)
 *   · pessimistic same-bar resolution: if both stop and target are
 *     touched inside one bar, the STOP is assumed to fill first
 *   · win = target touched first, loss = stop touched first
 *   · after HOLD_BARS without a touch → time exit at that bar's close
 *   · MFE / MAE tracked in points (favourable / adverse excursion)
 *
 * Two callers share this module:
 *   · scripts/scoreSignals.ts — nightly: replays every recorded signal
 *     against the COLLECTED session files (complete sessions)
 *   · lib/signalOutcomes.ts — intraday: re-scores today's still-open
 *     signals against the LIVE minute bars as the day progresses
 *
 * Purely observational: it writes outcome columns AFTER the fact and is
 * never read by the signal engine — it cannot change any decision.
 * ------------------------------------------------------------------ */

export type ScoredBars = { t: string; high: number; low: number; close: number };

export type SignalOutcome = {
  /** win | loss | time | open | "" (unscored) */
  outcome: "win" | "loss" | "time" | "open" | "";
  exitPrice: number | null;
  exitTime: string | null;
  exitReason: "target" | "stop" | "time" | null;
  /** maximum favourable excursion in points (0 when the trade never moved favourably) */
  mfePts: number | null;
  /** maximum adverse excursion in points */
  maePts: number | null;
  /** bars the walk lasted (0 = stopped/targeted immediately, null = unscored) */
  holdBars: number | null;
};

/** bars a scored trade is allowed to run before the time exit (matches the
 *  backtest's HOLD_BARS convention) */
export const SIGNAL_HOLD_BARS = 60;

function minuteOf(t: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Score one signal against feed-clock minute bars.
 * `entryT` is the signal's minute in the same clock as the bars.
 * `completeSession` = the bars run to the END of the session (collected
 * file): a walk that runs out of bars counts as a time exit at the last
 * close. When false (live intraday bars), running out of bars means the
 * trade is still open.
 */
export function scoreSignalBars(
  bars: readonly ScoredBars[],
  entryT: string,
  side: "long" | "short",
  entry: number,
  stop: number,
  target: number,
  opts: { holdBars?: number; completeSession?: boolean } = {},
): SignalOutcome {
  const holdBars = opts.holdBars ?? SIGNAL_HOLD_BARS;
  const complete = opts.completeSession ?? true;
  const empty: SignalOutcome = { outcome: "", exitPrice: null, exitTime: null, exitReason: null, mfePts: null, maePts: null, holdBars: null };
  if (![entry, stop, target].every(Number.isFinite)) return empty;
  if (side === "long" && !(stop < entry && entry < target)) return empty;
  if (side === "short" && !(target < entry && entry < stop)) return empty;

  // the entry bar is the bar stamped with the signal's own minute — if that
  // bar is not in the data (wrong session file / clock mismatch), don't guess
  const em = minuteOf(entryT);
  let start = -1;
  for (let i = 0; i < bars.length; i++) {
    if (minuteOf(bars[i].t) === em) {
      start = i;
      break;
    }
  }
  if (start < 0) return empty;

  const dir = side === "long" ? 1 : -1;
  const end = Math.min(bars.length - 1, start + holdBars);
  let mfe = 0;
  let mae = 0;

  for (let j = start + 1; j <= end; j++) {
    const b = bars[j];
    const fav = dir === 1 ? b.high - entry : entry - b.low;
    const adv = dir === 1 ? entry - b.low : b.high - entry;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    const hitStop = side === "long" ? b.low <= stop : b.high >= stop;
    const hitTarget = side === "long" ? b.high >= target : b.low <= target;
    if (hitStop && hitTarget) {
      // pessimistic: the stop fills first inside a bar that spans both
      return { outcome: "loss", exitPrice: stop, exitTime: b.t, exitReason: "stop", mfePts: mfe, maePts: mae, holdBars: j - start };
    }
    if (hitStop) {
      return { outcome: "loss", exitPrice: stop, exitTime: b.t, exitReason: "stop", mfePts: mfe, maePts: mae, holdBars: j - start };
    }
    if (hitTarget) {
      return { outcome: "win", exitPrice: target, exitTime: b.t, exitReason: "target", mfePts: mfe, maePts: mae, holdBars: j - start };
    }
  }

  // no touch within the window
  if (end >= bars.length - 1 && !complete) {
    // live session — the bars just haven't printed yet
    return { outcome: "open", exitPrice: null, exitTime: null, exitReason: null, mfePts: mfe, maePts: mae, holdBars: end - start };
  }
  // time exit at the last walked bar's close (the backtest convention)
  const last = bars[end];
  const exit = last.close > 0 ? last.close : side === "long" ? last.low : last.high;
  const pnl = (exit - entry) * dir;
  return {
    outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "time",
    exitPrice: exit,
    exitTime: last.t,
    exitReason: "time",
    mfePts: mfe,
    maePts: mae,
    holdBars: end - start,
  };
}
