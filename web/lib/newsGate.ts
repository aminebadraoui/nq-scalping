/* ------------------------------------------------------------------ *
 * News blackout gate — no new entries around scheduled US releases.
 *
 * Two reasons, one gate:
 *   1. Compliance: funded-account rules ban trading Tier-1 news; a trade
 *      held through a release is a rule breach.
 *   2. Edge: the tape around CPI / NFP / FOMC is untradeable noise for
 *      minute-bar structure signals — the momentum study shows no edge
 *      there, and slippage spikes.
 *
 * The calendar is STATIC data in this file (dates + ET release times):
 *   · FOMC 2026 decision days — from the Fed's official calendar
 *     (federalreserve.gov/monetarypolicy/fomccalendars.htm), 14:00 ET
 *     statements, press conferences 14:30.
 *   · Employment Situation (NFP) — first Friday (second if the 1st is a
 *     Friday), 8:30 ET.
 *   · CPI — BLS 2026 schedule, 8:30 ET.
 *   · PPI — BLS 2026 schedule, 8:30 ET (the day after CPI; refresh when
 *     the BLS posts the next year's schedule).
 * REFRESH CADENCE: update this file each December for the next year, and
 * re-check PPI dates quarterly — a stale date fails OPEN (no block), so
 * keep it current.
 *
 * Pure functions, unit-tested. NEWS_BLACKOUT_MIN overrides the default
 * windows per event kind.
 * ------------------------------------------------------------------ */

export type NewsEvent = {
  /** "YYYY-MM-DD" New York */
  day: string;
  /** release hour ET (0-23) */
  hourET: number;
  /** release minute ET */
  minuteET: number;
  label: string;
  kind: "fomc" | "bls";
  /** minutes before the release the blackout starts */
  beforeMin: number;
  /** minutes after the release the blackout ends */
  afterMin: number;
};

const FOMC: Array<[string, string]> = [
  ["2026-01-28", "FOMC decision"],
  ["2026-03-18", "FOMC decision"],
  ["2026-04-29", "FOMC decision"],
  ["2026-06-17", "FOMC decision"],
  ["2026-07-29", "FOMC decision"],
  ["2026-09-16", "FOMC decision"],
  ["2026-10-28", "FOMC decision"],
  ["2026-12-09", "FOMC decision"],
];

/** 2026 FOMC decision days, exported for the seasonal card chips
 *  (lib/seasonal.ts) — single source of truth for the current year. */
export const FOMC_DECISION_DAYS: string[] = FOMC.map(([day]) => day);

const BLS_0830: Array<[string, string]> = [
  // Employment Situation (NFP) — first Friday (second when the 1st is a Friday)
  ["2026-10-02", "Employment Situation"],
  ["2026-11-06", "Employment Situation"],
  ["2026-12-04", "Employment Situation"],
  ["2027-01-08", "Employment Situation"],
  // CPI
  ["2026-10-13", "CPI"],
  ["2026-11-10", "CPI"],
  ["2026-12-10", "CPI"],
  ["2027-01-12", "CPI"],
  // PPI (the day after CPI on the 2026 BLS schedule — refresh quarterly)
  ["2026-10-14", "PPI"],
  ["2026-11-12", "PPI"],
  ["2026-12-11", "PPI"],
  ["2027-01-13", "PPI"],
];

export const NEWS_EVENTS: NewsEvent[] = [
  ...FOMC.map(([day, label]) => ({
    day,
    hourET: 14,
    minuteET: 0,
    label,
    kind: "fomc" as const,
    beforeMin: 10,
    afterMin: 20,
  })),
  ...BLS_0830.map(([day, label]) => ({
    day,
    hourET: 8,
    minuteET: 30,
    label,
    kind: "bls" as const,
    beforeMin: 5,
    afterMin: 10,
  })),
];

/** is a New York day+time inside a release blackout? Returns the event
 *  label when blocked, null when clear. Pure — the test fixture feeds it
 *  synthetic days. */
export function newsBlockedAt(
  events: NewsEvent[],
  day: string, // "YYYY-MM-DD" New York
  hourET: number,
  minuteET: number,
): string | null {
  const nowMin = hourET * 60 + minuteET;
  for (const e of events) {
    if (e.day !== day) continue;
    const relMin = e.hourET * 60 + e.minuteET;
    if (nowMin >= relMin - e.beforeMin && nowMin <= relMin + e.afterMin) {
      return e.label;
    }
  }
  return null;
}

/** New York "YYYY-MM-DD" + clock for an epoch-ms instant (DST-aware via
 *  the America/New_York timezone). */
export function etDayAndClock(nowMs: number): { day: string; hourET: number; minuteET: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(nowMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value])) as Record<string, string>;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hourET: Number(p.hour),
    minuteET: Number(p.minute),
  };
}

/** convenience: is NOW inside a blackout (events = NEWS_EVENTS)? */
export function newsBlockedNow(nowMs: number): string | null {
  const t = etDayAndClock(nowMs);
  return newsBlockedAt(NEWS_EVENTS, t.day, t.hourET, t.minuteET);
}
