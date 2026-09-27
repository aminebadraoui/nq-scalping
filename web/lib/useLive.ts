"use client";

import { useEffect, useState } from "react";

export type Snapshot = {
  date: string;
  open: number;
  high: number;
  low: number;
  ltp: number;
  volume: number;
  prev_close: number;
  prev_date: string;
  s_type: string;
  delta: number;
};

export type LiveMinute = {
  t: string;
  /** calendar date of the bar (feed clock) — only set for collected bars, so
   *  an overnight session that crosses midnight maps to the right instants */
  d?: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  buy: number;
  sell: number;
  live: boolean;
  /** price (0.25-tick) -> [buy, sell] — live per-tick clusters (recent minutes only) */
  levels?: Record<string, [number, number]>;
};

export type LiveState = {
  connected: boolean;
  lastMessage: number;
  snapshot: Snapshot | null;
  ticks: unknown[];
  minutes: LiveMinute[];
  cur: LiveMinute | null;
};

export function useLive(): LiveState | null {
  const [live, setLive] = useState<LiveState | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/live");
    es.onmessage = (e) => {
      try {
        setLive(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);
  return live;
}
