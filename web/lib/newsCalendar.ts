/* ------------------------------------------------------------------ *
 * Weekly high-impact US news calendar — DISPLAY-ONLY macro context
 * (the signal engine never imports this; its own blackout list lives
 * in lib/newsGate.ts and is unchanged).
 *
 * Source chain, best → fallback (each stage degrades gracefully):
 *   1. FOREXFACTORY mirror nfs.faireconomy.media/ff_calendar_thisweek.json
 *      — keyless, impact tiers + forecast/previous (NO actual). An
 *      UNOFFICIAL mirror: rate-limits hard (429 HTML after a couple of
 *      hits), may drift or vanish. TTL 15 min = gentle. Its week view
 *      rolls on Sunday — on Saturday it still serves the week just
 *      ended, which fetchNewsWeek treats as a miss (see below).
 *   2. STATIC — official Fed/BLS schedule already maintained in
 *      lib/newsGate.ts (FOMC / Employment Situation / CPI / PPI); on a
 *      weekend or after Friday's releases it shows the NEXT scheduled
 *      week.
 * The panel never goes blank and always shows which source it is
 * displaying. The keyed actual-carrying calendars are all paid in
 * Oct 2026 — verified with real free keys: Finnhub /calendar/economic
 * = premium tier, FMP economic_calendar = paid (v3 legacy-locked,
 * /stable 402 "Restricted Endpoint"). Documented in
 * docs/data/economic-calendar-source-research-2026-10.md.
 *
 * Pure parsers, unit-tested (tests/newsCalendar.test.mjs).
 * ------------------------------------------------------------------ */

import { NEWS_EVENTS, etDayAndClock } from "./newsGate";

export type NewsImpact = "High" | "Medium" | "Low" | "Holiday";

export type NewsItem = {
  /** "YYYY-MM-DD" (New York) */
  day: string;
  /** "HH:MM" ET 24h; "" = all-day */
  timeET: string;
  title: string;
  impact: NewsImpact;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** true when the release time has already passed (ET) */
  released: boolean;
};

export type NewsDay = {
  /** "YYYY-MM-DD" */
  day: string;
  items: NewsItem[];
};

export type NewsWeek = {
  /** which upstream produced this payload (shown on the panel) */
  source: "forexfactory" | "static";
  days: NewsDay[];
};

/* ---------------- time helpers ------------------------------------- */

/** current ET "YYYY-MM-DD" + minute-of-day */
export function etNow(): { day: string; minute: number } {
  const t = etDayAndClock(Date.now());
  return { day: t.day, minute: t.hourET * 60 + t.minuteET };
}

function dow(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** the Mon–Fri trading week for `day` (New York). Sat/Sun resolve to
 *  the UPCOMING week — "the news for the week" on a weekend means next
 *  week, which is also what ForexFactory's weekly view shows. */
export function weekDaysOf(day: string): string[] {
  const d = dow(day);
  const monOffset = d === 0 ? 1 : d === 6 ? 2 : 1 - d;
  return Array.from({ length: 5 }, (_, i) => addDays(day, monOffset + i));
}

/** next Monday strictly after `day` */
export function nextMonday(day: string): string {
  const d = dow(day);
  return addDays(day, d === 0 ? 1 : 8 - d);
}

/* ---------------- shared grouping -------------------------------- */

/** mark released + group into ET days. `anchorDay` picks the Mon–Fri
 *  week to display: the feed's own week for the single-week FF mirror,
 *  "now" for range queries (Finnhub) so a weekend read shows the
 *  UPCOMING week, not the trailing half of the query window. */
function groupItems(items: NewsItem[], now: { day: string; minute: number }, anchorDay: string): NewsWeek {
  if (items.length === 0) return { source: "forexfactory", days: [] };
  const range = weekDaysOf(anchorDay);
  const nowHHMM = Math.floor(now.minute / 60) * 100 + (now.minute % 60);
  const picked = items
    .filter((x) => range.includes(x.day))
    .map((x) => {
      let passed: boolean;
      if (x.day < now.day) passed = true;
      else if (x.day > now.day) passed = false;
      else passed = x.timeET !== "" && hhmm(x.timeET) <= nowHHMM; // all-day = not yet released
      return { ...x, released: passed };
    })
    .sort((a, b) => (a.day === b.day ? a.timeET.localeCompare(b.timeET) : a.day < b.day ? -1 : 1));
  const days: NewsDay[] = [];
  for (const it of picked) {
    const last = days[days.length - 1];
    if (last && last.day === it.day) last.items.push(it);
    else days.push({ day: it.day, items: [it] });
  }
  return { source: "forexfactory", days };
}

/** does the week still hold at least one not-yet-released event? */
export function hasUpcoming(week: NewsWeek): boolean {
  return week.days.some((d) => d.items.some((i) => !i.released));
}

/** hhmm of "HH:MM" */
function hhmm(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 100 + m;
}

/* ---------------- ForexFactory mirror parsing --------------------- */

type FfEvent = {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
};

function isImpact(v: string | undefined): v is NewsImpact {
  return v === "High" || v === "Medium" || v === "Low" || v === "Holiday";
}

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function ffToItem(e: FfEvent): NewsItem | null {
  if (!e.title || !e.date || e.country !== "USD" || !isImpact(e.impact)) return null;
  const ms = Date.parse(e.date);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value])) as Record<string, string>;
  const str = (v: string | undefined): string | null => (v == null || v === "" ? null : unesc(v));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    timeET: `${p.hour}:${p.minute}`,
    title: unesc(e.title),
    impact: e.impact,
    forecast: str(e.forecast),
    previous: str(e.previous),
    actual: str(e.actual), // the mirror does not carry it — stays null
    released: false,
  };
}

export function buildNewsWeek(raw: FfEvent[], now: { day: string; minute: number }): NewsWeek {
  const items = raw
    .map(ffToItem)
    .filter((x): x is NewsItem => x !== null && (x.impact === "High" || x.impact === "Medium"));
  if (items.length === 0) return { source: "forexfactory", days: [] };
  // the single-week mirror defines its own window — anchor on it
  const anchor = items.reduce((min, x) => (x.day < min ? x.day : min), items[0].day);
  const w = groupItems(items, now, anchor);
  return { ...w, source: "forexfactory" };
}

/* ---------------- static fallback calendar ------------------------ *
 * Reuses the Fed/BLS schedule already maintained for the newsGate
 * blackout (FOMC decisions 14:00 ET, Employment Situation/CPI/PPI
 * 8:30 ET). Displays the week containing the earliest upcoming event
 * (on a weekend that is next week), falling back to the most recent
 * week that had any event so the panel is never empty.
 * ------------------------------------------------------------------ */

function staticItem(e: (typeof NEWS_EVENTS)[number], now: { day: string; minute: number }): NewsItem {
  const hh = String(e.hourET).padStart(2, "0");
  const mm = String(e.minuteET).padStart(2, "0");
  const today = e.day === now.day;
  const passed = today ? e.hourET * 60 + e.minuteET <= now.minute : e.day < now.day;
  return {
    day: e.day,
    timeET: `${hh}:${mm}`,
    title: e.label,
    impact: "High" as const,
    forecast: null,
    previous: null,
    actual: null,
    released: passed,
  };
}

export function staticWeek(now: { day: string; minute: number }): NewsWeek {
  const items = NEWS_EVENTS.map((e) => staticItem(e, now));
  const next = items.filter((i) => !i.released).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0];
  // no upcoming static event (weekend / after Friday's releases) →
  // show the most recent week that had events, not the oldest
  const anchor = next
    ? next.day
    : items.reduce((max, i) => (i.day > max ? i.day : max), items[0]?.day ?? now.day);
  const range = weekDaysOf(anchor);
  const picked = items.filter((i) => range.includes(i.day));
  const days: NewsDay[] = [];
  for (const it of picked) {
    const last = days[days.length - 1];
    if (last && last.day === it.day) last.items.push(it);
    else days.push({ day: it.day, items: [it] });
  }
  return { source: "static", days };
}

/* ---------------- fetch chain (server-side) ----------------------- */

const FF_WEEK_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

async function fetchForexFactory(now: { day: string; minute: number }): Promise<NewsWeek> {
  const res = await fetch(FF_WEEK_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NQDashboard/1.0)", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`FF mirror HTTP ${res.status}`);
  const j = (await res.json()) as FfEvent[];
  if (!Array.isArray(j) || j.length === 0) throw new Error("FF mirror empty payload");
  const week = buildNewsWeek(j, now);
  if (week.days.length === 0) throw new Error("no USD High events in feed window");
  // the mirror is a single-week feed: on Saturday it still serves the
  // week just ended. A fully-released week is useless as "week ahead",
  // so treat it as a miss and let the static calendar take over.
  if (!hasUpcoming(week)) throw new Error("feed week fully released (weekend)");
  return week;
}

/** best-available week; throws only when the mirror failed (the API
 *  route then serves the cache or the static calendar) */
export async function fetchNewsWeek(): Promise<{ data: NewsWeek; fetchedAt: string }> {
  return { data: await fetchForexFactory(etNow()), fetchedAt: new Date().toISOString() };
}
