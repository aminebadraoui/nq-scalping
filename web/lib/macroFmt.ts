/* Display formatting for the macro panels — pure, unit-testable.
 * Everything is ET (America/New_York), matching the dashboard. */

import { etToEpoch } from "./times";
import { etDayAndClock } from "./newsGate";
import type { NewsItem, NewsWeek } from "./newsCalendar";

/** current instant, ET */
export function etNow(): { day: string; sec: number } {
  const t = etDayAndClock(Date.now());
  return { day: t.day, sec: Math.floor(Date.now() / 1000) };
}

/** whole ET days from today to `dayISO` (negative = past) */
export function daysAway(dayISO: string, nowDay: string): number {
  const [y, m, d] = dayISO.split("-").map(Number);
  const [ny, nm, nd] = nowDay.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ny, nm - 1, nd)) / 86_400_000);
}

/** epoch seconds of an event's release instant (ET) */
export function eventEpoch(item: NewsItem): number {
  return etToEpoch(item.timeET || "00:00", item.day);
}

/** "in 42m" · "in 3h 12m" · "in 2d 4h"; null when released/unknown */
export function countdownLabel(item: NewsItem, nowSec: number): string | null {
  if (item.released || !item.timeET) return null;
  const diff = eventEpoch(item) - nowSec;
  if (diff <= 0 || !Number.isFinite(diff)) return null;
  const mins = Math.round(diff / 60);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

/** minutes until release; Infinity when released/unknown (strip colors <15) */
export function minutesUntil(item: NewsItem, nowSec: number): number {
  if (item.released || !item.timeET) return Infinity;
  const diff = eventEpoch(item) - nowSec;
  return diff > 0 && Number.isFinite(diff) ? Math.round(diff / 60) : Infinity;
}

/** the first upcoming event of the week (strip headline) */
export function nextUpcoming(week: NewsWeek | null): NewsItem | null {
  if (!week) return null;
  const all = week.days.flatMap((d) => d.items);
  const upcoming = all.filter((i) => !i.released).sort((a, b) => eventEpoch(a) - eventEpoch(b));
  return upcoming[0] ?? null;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** "MON OCT 5" from "2026-10-05" */
export function dayLabel(dayISO: string): string {
  const [y, m, d] = dayISO.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${DAYS[dow]} ${month.toUpperCase()} ${d}`;
}

/** "Oct 28" from "2026-10-28" */
export function shortDate(dayISO: string): string {
  const [y, m, d] = dayISO.split("-").map(Number);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${month} ${d}`;
}

/** signed value with explicit sign: "+0.04", "−0.02" */
export function signed(n: number | null, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = n.toFixed(dp);
  return n > 0 ? `+${v}` : v;
}

/** surprise % with sign and arrow: "+12.6% ▲" */
export function surpriseLabel(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "·";
  return `${sign}${pct.toFixed(1)}% ${arrow}`;
}

/** implied fed funds rate from the front-month FF futures price
 *  (100 − price). Client-safe pure helper. */
export function impliedFfr(ffPrice: number | null): number | null {
  if (ffPrice == null || !Number.isFinite(ffPrice)) return null;
  return Math.round((100 - ffPrice) * 100) / 100;
}


/** realized daily 1σ move in PERCENT from the last `lookback` 1-min
 *  closes: stdev of log returns × √390 (1-min bars per RTH day).
 *  Live-native — the delayed-VIX band's real-time counterpart. */
export function realizedDailyBandPct(minutes: { c: number }[], lookback = 30): number | null {
  const closes = minutes.slice(-lookback).map((m) => m.c).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 5) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sigma1m = Math.sqrt(variance);
  return Math.round(sigma1m * Math.sqrt(390) * 100 * 100) / 100;
}
