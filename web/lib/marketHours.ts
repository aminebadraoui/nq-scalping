/* ------------------------------------------------------------------ *
 * Market-hours calendar — the ONE place that knows when the market is
 * open. CME Globex (equity index futures):
 *
 *   · session: 18:00 ET → next calendar day 17:00 ET (daily halt
 *     17:00–18:00 ET), Sunday 18:00 ET through Friday 17:00 ET
 *   · full holidays close the whole session
 *   · early-close days shut at the listed minute (13:00 ET Jul 3,
 *     13:15 ET day after Thanksgiving) with no evening reopen
 *
 * Consumers:
 *   · lib/live.ts — the feed watchdog now forces a reconnect whenever
 *     the market SHOULD be open but no print has arrived (the old
 *     watchdog needed vendor volume to be moving, which is exactly
 *     what's missing when the feed is dead)
 *   · lib/live.ts — bootstrap + rollover handling key off the calendar
 *   · /api/gc?action=health — reports `market.open` so a dead feed is
 *     distinguishable from a closed market at a glance
 *
 * Pure + unit-tested. Holiday table covers 2026; refresh in December.
 * ------------------------------------------------------------------ */

import { sessionDayOf } from "./times";

/** CME 2026 equity-index holidays. `earlyCloseMin` = session close in
 *  minutes since ET midnight; absent = fully closed. */
export const CME_HOLIDAYS_2026: Record<string, { label: string; earlyCloseMin?: number }> = {
  "2026-01-01": { label: "New Year's Day" },
  "2026-01-19": { label: "Martin Luther King Jr. Day" },
  "2026-02-16": { label: "Presidents' Day" },
  "2026-04-03": { label: "Good Friday" },
  "2026-05-25": { label: "Memorial Day" },
  "2026-06-19": { label: "Juneteenth" },
  "2026-07-03": { label: "Independence Day (observed)", earlyCloseMin: 13 * 60 },
  "2026-09-07": { label: "Labor Day" },
  "2026-11-26": { label: "Thanksgiving Day" },
  "2026-11-27": { label: "Day after Thanksgiving", earlyCloseMin: 13 * 60 + 15 },
  "2026-12-25": { label: "Christmas Day" },
};

export type ETClock = {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  dow: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
};

/** New-York wall-clock parts for an epoch-ms instant. */
export function etParts(tsMs: number): ETClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(tsMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value])) as Record<string, string>;
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    dow: p.weekday as ETClock["dow"],
  };
}

/** "YYYY-MM-DD" of the New-York calendar day for an epoch-ms instant. */
export function etDate(tsMs: number): string {
  const p = etParts(tsMs);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Is the CME Globex market open at this instant?
 * Sun 18:00 ET → Fri close (17:00 ET, or the holiday early close),
 * minus the daily 17:00–18:00 ET halt on Mon–Thu.
 */
export function marketOpenAt(tsMs: number, holidays: typeof CME_HOLIDAYS_2026 = CME_HOLIDAYS_2026): boolean {
  const p = etParts(tsMs);
  const hm = p.hour * 60 + p.minute;
  const h = holidays[`${p.year}-${p.month}-${p.day}`];
  if (h && h.earlyCloseMin === undefined) return false;
  const closeMin = h?.earlyCloseMin ?? 17 * 60;
  if (p.dow === "Sat") return false;
  if (p.dow === "Sun") return hm >= 18 * 60;
  if (p.dow === "Fri") return hm < closeMin;
  return hm < closeMin || hm >= 18 * 60; // Mon–Thu, 17:00–18:00 halt
}

export type MarketEvent = {
  kind: "open" | "close";
  /** epoch ms of the boundary (open = the first open minute) */
  atMs: number;
  label?: string;
};

/** The next open/close boundary after `tsMs` (minute-granular scan, exact). */
export function nextMarketEvent(
  tsMs: number,
  holidays: typeof CME_HOLIDAYS_2026 = CME_HOLIDAYS_2026,
): MarketEvent {
  const openNow = marketOpenAt(tsMs, holidays);
  let t = tsMs;
  for (let i = 0; i < 72 * 60 * 2; i++) {
    const next = t + 60_000;
    const o = marketOpenAt(next, holidays);
    if (o !== openNow) return { kind: o ? "open" : "close", atMs: next };
    t = next;
  }
  // weekend cap fallback: next Sunday 18:00 ET
  const p = etParts(tsMs);
  const daysToSunday = (7 - ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.dow)) % 7;
  const sun = new Date(`${etDate(tsMs)}T00:00:00Z`).getTime() + daysToSunday * 86_400_000;
  return { kind: "open", atMs: sun + 18 * 3_600_000 };
}

export type MarketStatus = {
  open: boolean;
  sessionDay: string;
  next: MarketEvent;
};

export function marketStatus(tsMs: number, holidays?: typeof CME_HOLIDAYS_2026): MarketStatus {
  return { open: marketOpenAt(tsMs, holidays), sessionDay: sessionDayOf(tsMs), next: nextMarketEvent(tsMs, holidays) };
}
