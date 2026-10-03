"use client";

import { useEffect, useState } from "react";

export type DomLevel = { p: number; s: number };

export type IcebergCandidate = {
  side: "bid" | "ask";
  price: number;
  size: number;
  absorbed: number;
  refills: number;
  refillSize: number;
  refillConsistency: number;
  confidence: number;
  lastRefillMs: number;
  peak: number;
};

export type DomState = {
  connected: boolean;
  lastMessage: number;
  snapshots: number;
  increments: number;
  lastSeq: number;
  book: { bids: DomLevel[]; asks: DomLevel[] };
  icebergs: IcebergCandidate[];
};

export function useDom(): DomState | null {
  const [dom, setDom] = useState<DomState | null>(null);
  useEffect(() => {
    const es = new EventSource("/api/dom");
    es.onmessage = (e) => {
      try {
        setDom(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);
  return dom;
}
