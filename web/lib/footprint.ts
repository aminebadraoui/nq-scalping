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
import { utcToFeed } from "./times";

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

/** a marker drawn on the chart for a detected event */
export type Marker = { t: string; kind: string; bias: "bull" | "bear" | null };

/** an absorption event, as returned by the analysis endpoint */
export type Absorb = { t: string; price: number; side: "bid" | "ask"; bias: "bull" | "bear" };
