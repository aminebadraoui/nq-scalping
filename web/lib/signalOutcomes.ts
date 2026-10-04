/* ------------------------------------------------------------------ *
 * Signal outcome service — scores recorded signals against price data
 * and persists win/loss into the signals table.
 *
 * Two entry points, sharing lib/signalScorer.ts:
 *   · scoreSignalFromFiles() — historical/nightly: replays the signal
 *     against the COLLECTED session file (complete session).
 *   · updateLiveOutcomes() — intraday: re-scores today's still-open
 *     signals against the LIVE minute bars as the day progresses.
 *
 * Purely observational: these functions only WRITE the outcome columns
 * of already-recorded rows. The signal engine never reads them, so they
 * cannot change any decision. A DB hiccup is swallowed silently.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { extractFootprint } from "./gcdata";
import { etToFeed, utcToFeedStamp } from "./times";
import { scoreSignalBars, type SignalOutcome } from "./signalScorer";
import { updateSignalOutcome } from "./signalHistory";
import type { LiveMinute } from "./live";

type ScorableSignal = {
  key: string;
  day: string;
  timeET: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
};

/** parse a recorded row into scorable form; null when it can't be replayed
 *  (reversal-style text levels, missing side, or invalid geometry) */
export function toScorable(s: { key: string; day: string; timeET: string; side: string; entry: string; stop: string; target: string }): ScorableSignal | null {
  if (s.side !== "long" && s.side !== "short") return null;
  const entry = parseFloat(s.entry);
  const stop = parseFloat(s.stop);
  const target = parseFloat(s.target);
  if (![entry, stop, target].every(Number.isFinite)) return null;
  if (s.side === "long" && !(stop < entry && entry < target)) return null;
  if (s.side === "short" && !(target < entry && entry < stop)) return null;
  return { key: s.key, day: s.day, timeET: s.timeET, side: s.side, entry, stop, target };
}

function prevDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Score one signal against the collected session files. The signal's day is
 * the bar's own feed-calendar day, while an ETH file may be labelled by its
 * start evening — so BOTH the signal day and the previous day are tried and
 * the one that actually contains the entry bar wins.
 */
export async function scoreSignalFromFiles(s: ScorableSignal): Promise<SignalOutcome | null> {
  const t = etToFeed(s.timeET);
  for (const date of [s.day, prevDay(s.day)]) {
    const fp = await extractFootprint(date, "ETH");
    if (!fp || fp.minutes.length === 0) continue;
    const bars = fp.minutes.map((m) => ({
      t: m.t,
      high: m.high,
      low: m.low,
      close: m.c > 0 ? m.c : (m.high + m.low) / 2,
    }));
    const o = scoreSignalBars(bars, t, s.side, s.entry, s.stop, s.target, { completeSession: true });
    if (o.outcome !== "") return o;
  }
  return null;
}

type OpenRow = { key: string; day: string; time_et: string; side: string; entry: string; stop: string; target: string; outcome: string };

/**
 * Intraday outcome tracker — re-scores the still-open/unscored signals from
 * the LIVE minute bars. Only signals from the CURRENT session day are
 * touched (a yesterday row would false-match today's same-time-of-day bars;
 * the nightly file scoring owns those). Writes only when the outcome CHANGED
 * (so the 15s loop never hammers the DB). Signals whose entry bar isn't in
 * the live buffer are left alone.
 */
export async function updateLiveOutcomes(minutes: LiveMinute[]): Promise<number> {
  if (!dbEnabled() || minutes.length === 0) return 0;

  // live minutes → feed-clock bars (the same conversion the detectors use);
  // the day of the LAST live bar is the only day these bars can score
  const bars: { t: string; high: number; low: number; close: number }[] = [];
  let lastBarDay = "";
  for (const m of minutes) {
    if (!/^\d{2}:\d{2}$/.test(m.t)) continue;
    const stamp = utcToFeedStamp(m.t, m.du);
    if (!stamp.hhmm) continue;
    bars.push({ t: stamp.hhmm, high: m.h, low: m.l, close: m.c });
    lastBarDay = stamp.day;
  }
  if (bars.length === 0 || !lastBarDay) return 0;

  let rows: OpenRow[] = [];
  try {
    rows = (await getDb()`
      select key, day, time_et, side, entry, stop, target, outcome
      from signals
      where side in ('long','short') and (outcome = '' or outcome = 'open')
        and day = ${lastBarDay}
      order by ts desc limit 200`) as unknown as OpenRow[];
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;

  let updated = 0;
  for (const r of rows) {
    const s = toScorable({ key: r.key, day: r.day, timeET: r.time_et, side: r.side, entry: r.entry, stop: r.stop, target: r.target });
    if (!s) continue;
    const o = scoreSignalBars(bars, etToFeed(s.timeET), s.side, s.entry, s.stop, s.target, { completeSession: false });
    if (o.outcome === "" || o.outcome === r.outcome) continue;
    await updateSignalOutcome(s.key, {
      outcome: o.outcome,
      exitPrice: o.exitPrice,
      exitTime: o.exitTime ?? "",
      exitReason: o.exitReason ?? "",
      mfePts: o.mfePts,
      maePts: o.maePts,
    });
    updated++;
  }
  return updated;
}
