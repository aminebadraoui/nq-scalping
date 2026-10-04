"use client";

/* Polls /api/macro for the dashboard macro panels. The route owns all
 * upstream caching; this hook is a thin 60s poller with a stale flag.
 * Display-only — no signal code imports this. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MacroContext } from "@/lib/macroFeed";

export type MacroPoll = {
  ctx: MacroContext | null;
  error: string | null;
  /** last successful data age in ms (null = never loaded) */
  ageMs: number | null;
  refresh: () => void;
};

const POLL_MS = 60_000;

export function useMacro(): MacroPoll {
  const [ctx, setCtx] = useState<MacroContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ageMs, setAgeMs] = useState<number | null>(null);
  const tick = useRef(0);

  const refresh = useCallback(() => {
    tick.current += 1;
    const my = tick.current;
    fetch("/api/macro")
      .then((r) => r.json())
      .then((j: MacroContext & { ok?: boolean }) => {
        if (my !== tick.current) return;
        setCtx(j);
        setError(null);
        setAgeMs(0);
      })
      .catch((e) => {
        if (my !== tick.current) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      refresh();
      setAgeMs((a) => (a === null ? null : a + POLL_MS));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { ctx, error, ageMs, refresh };
}
