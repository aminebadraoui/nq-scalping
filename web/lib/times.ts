/* ------------------------------------------------------------------ *
 * Timezone helpers.
 *
 * Conventions in this codebase:
 *   · collected feed bars are stamped in the exchange clock = US Central
 *     ("feed clock"), e.g. 08:30 = 09:30 New York
 *   · live ticks are bucketed by UTC wall clock (see lib/live.ts)
 *   · everything displayed is New York (America/New_York)
 *
 * The UTC→ET shift is NOT a constant (−4h EDT / −5h EST) and neither is the
 * feed→ET shift: Chicago and New York switch DST at the same LOCAL clock
 * reading, not at the same UTC instant, so for one hour a year the two zones
 * are 2 hours apart in UTC terms:
 *   · 2nd Sunday of March, 07:00–08:00 UTC = CT 01:00–01:59 (naive +1h is 1 h short)
 *   · 1st Sunday of November, 06:00–07:00 UTC = CT 01:00–01:59 CDT pass (naive +1h is 1 h late)
 * Both windows sit outside RTH but inside the Globex/overnight session, so an
 * ETH bar stamped 01:00–01:59 on those two dates per year is the only case a
 * bare "+1 hour" gets wrong. `feedToEpoch` resolves the zone through Intl and
 * is exact; `cdtToET` is a display helper with exactly that known exception.
 * ------------------------------------------------------------------ */

/** feed clock (US Central wall time) → New York. Always exactly +1h. */
export function cdtToET(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h + 1) % 24) + 24) % 24;
  return `${String(t).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}

/** New York → feed clock. Always exactly −1h (used to key live data). */
export function etToFeed(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h - 1) % 24) + 24) % 24;
  return `${String(t).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
}

/** epoch seconds → "HH:mm" in New York (DST-correct, via Intl). */
export function fmtETTime(sec: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(sec * 1000));
}

/**
 * UTC wall-clock "HH:mm" → New York "HH:mm".
 * `utcDate` is the UTC calendar day the tick belongs to (defaults to today,
 * UTC) — it decides whether EDT (−4h) or EST (−5h) applies.
 */
export function utcToET(hhmm: string, utcDate?: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const day = utcDate ?? new Date().toISOString().slice(0, 10);
  const iso = `${day}T${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}:00Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return hhmm;
  return fmtETTime(Math.floor(ms / 1000));
}

/**
 * UTC wall-clock "HH:mm" → feed clock "HH:mm" (ET − 1h).
 * Live minutes are UTC-keyed while every event the analysis produces
 * (absorption, divergence, reclaim, absorption times) is feed-keyed, so
 * matching the two requires this conversion — comparing the raw strings
 * silently drops every live event.
 */
export function utcToFeed(hhmm: string, utcDate?: string): string {
  return etToFeed(utcToET(hhmm, utcDate));
}

/* ------------------------------------------------------------------ *
 * Wall-clock → epoch. Both feed bars and live bars are stamped with a
 * wall clock, but the UTC offset changes with DST: the old code added a
 * hardcoded +5h (CDT), which silently plotted every winter bar an hour
 * early. Resolve the real offset with Intl instead.
 * ------------------------------------------------------------------ */

function tzOffsetMs(ms: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - ms; // negative west of UTC (-4h EDT / -5h EST)
}

/** wall clock in `timeZone` on a calendar day → epoch seconds (DST-correct). */
function wallToEpoch(hhmm: string, dateISO: string, timeZone: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const naive = Date.parse(`${dateISO}T${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}:00Z`);
  if (!Number.isFinite(naive)) return NaN;
  // two passes settle the offset across a DST boundary
  let ms = naive - tzOffsetMs(naive, timeZone);
  ms = naive - tzOffsetMs(ms, timeZone);
  return Math.floor(ms / 1000);
}

/** New York wall clock on a given calendar day → epoch seconds (DST-correct). */
export function etToEpoch(hhmm: string, dateISO: string): number {
  return wallToEpoch(hhmm, dateISO, "America/New_York");
}

/**
 * feed clock (US Central wall time) on a calendar day → epoch seconds.
 * Resolved against America/Chicago directly, so the one hour a year where a
 * bare "+1h to New York" is wrong is still mapped to the right instant.
 */
export function feedToEpoch(hhmm: string, dateISO: string): number {
  return wallToEpoch(hhmm, dateISO, "America/Chicago");
}

/** UTC wall-clock "HH:mm" → the feed's own wall clock, WITH its calendar day.
 *  Used to re-key live tick minutes so they continue a collected session
 *  seamlessly (the collected bars are stamped in US Central). */
export function utcToFeedStamp(hhmm: string, utcDate?: string): { day: string; hhmm: string } {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return { day: "", hhmm: "" };
  const day = utcDate ?? new Date().toISOString().slice(0, 10);
  const iso = `${day}T${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}:00Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return { day: "", hhmm: "" };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const g = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${g.year}-${g.month}-${g.day}`, hhmm: `${g.hour}:${g.minute}` };
}

/** UTC wall clock on a calendar day → epoch seconds. */
export function utcToEpoch(hhmm: string, dateISO?: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const day = dateISO ?? new Date().toISOString().slice(0, 10);
  return Math.floor(
    Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}:00Z`) / 1000,
  );
}
