/* ------------------------------------------------------------------ *
 * Client-side footprint contract.
 *
 * These are the shapes the browser gets from `/api/gc?action=footprint`
 * (collected data) and builds for live tick minutes — the same shapes the
 * dashboard's ladder, story panel and mechanism read all speak. Level and
 * imbalance types come from the shared engine so the server, the live
 * builder and the UI can never drift apart.
 * ------------------------------------------------------------------ */

export type { FPLevel, ImbStack, ImbSummary } from "./imbalance";
import type { FPLevel, ImbSummary } from "./imbalance";
import { utcToFeed, utcToEpoch, utcToFeedStamp } from "./times";

export type FPMinute = {
  t: string; // "HH:mm" — feed clock (US Central) for collected data, UTC for live ticks
  /** calendar date of this bar (feed clock); set on collected data only */
  d?: string;
  o?: number; // real open (absent when no OHLC exists for the date)
  c?: number;
  vwap?: number; // single-print VWAP of the minute
  high: number;
  low: number;
  buy: number; // volume traded at the ask (aggressive buying)
  sell: number; // volume traded at the bid (aggressive selling)
  delta: number;
  levels: FPLevel[];
  imb?: ImbSummary;
};

/**
 * Rewrite live (UTC-keyed) bars into the feed clock so they line up with the
 * events the analysis produces (absorption, divergence, reclaim), which are
 * always feed-keyed. Comparing the raw strings silently drops every live
 * event — that was a real bug: the checklist fell from 3/6 to 1/6 while live.
 */
export function toFeedClock<T extends { t: string; live?: boolean }>(minutes: T[]): T[] {
  return minutes.map((m) => (m.live ? { ...m, t: utcToFeed(m.t) } : m));
}

/**
 * Seamless live blend: the collected (feed-keyed) minutes, continued by the
 * live tick minutes that come AFTER the last collected minute. Live minutes
 * are re-keyed into the feed clock with their own calendar day, so the chart,
 * the ladder and every event match treat them like collected bars.
 * Overlaps (late ticks from before the session end) and the snapshot's
 * placeholder minute are dropped.
 */
export function blendLiveMinutes<T extends { t: string; d?: string; live?: boolean }>(
  hist: T[],
  live: T[],
  utcDate?: string,
): T[] {
  const last = hist[hist.length - 1];
  const lastTs = last ? feedEpoch(last) : 0;
  const out = [...hist];
  for (const m of live) {
    if (!/^\d{2}:\d{2}$/.test(m.t)) continue; // the snapshot's "now" placeholder
    // the bar's OWN utc date when it has one — after UTC midnight "today" is
    // already tomorrow and every live bar would land 24h in the future
    const day = (m as { du?: string }).du ?? utcDate;
    const ts = utcToEpoch(m.t, day);
    if (!Number.isFinite(ts) || ts <= lastTs) continue; // overlap or stale
    const stamp = utcToFeedStamp(m.t, day);
    if (!stamp.hhmm) continue;
    out.push({ ...m, t: stamp.hhmm, d: stamp.day, live: false } as T);
  }
  return out;
}

function feedEpoch<T extends { t: string; d?: string }>(m: T): number {
  // feed-keyed minute + its feed calendar day → the absolute instant
  const sec = feedToEpochStamp(m);
  return sec;
}

import { feedToEpoch } from "./times";
function feedToEpochStamp(m: { t: string; d?: string }): number {
  return feedToEpoch(m.t, m.d ?? new Date().toISOString().slice(0, 10));
}

/** a marker drawn on the chart for a detected event */
export type Marker = { t: string; kind: string; bias: "bull" | "bear" | null };

/** an absorption event, as returned by the analysis endpoint */
export type Absorb = { t: string; price: number; side: "bid" | "ask"; bias: "bull" | "bear" };
