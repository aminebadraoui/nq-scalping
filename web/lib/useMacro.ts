"use client";

/* Polls /api/macro for the dashboard macro panels. The route owns all
 * upstream caching (TTL + failure cool-down + last-good serving);
 * this hook is a thin 60s poller with a stale flag and a heal() that
 * POSTs {action:"heal"} to re-read every upstream now. Display-only —
 * no signal code imports this. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MacroContext } from "@/lib/macroFeed";

export type MacroPoll = {
  ctx: MacroContext | null;
  error: string | null;
  /** last successful data age in ms (null = never loaded) */
  ageMs: number | null;
  refresh: () => void;
  /** force a fresh upstream read (the frontend heal). Resolves with
   *  the cooldown remainder when the route declined the re-read. */
  heal: () => Promise<{ ok: boolean; cooldownRemainingMs: number }>;
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

  const heal = useCallback(async () => {
    tick.current += 1;
    const my = tick.current;
    try {
      const r = await fetch("/api/macro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "heal" }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = (await r.json()) as MacroContext & { ok?: boolean; cooldownRemainingMs?: number };
      if (my === tick.current && r.ok) {
        setCtx(j);
        setError(null);
        setAgeMs(0);
      }
      return { ok: r.ok, cooldownRemainingMs: j.cooldownRemainingMs ?? 0 };
    } catch (e) {
      if (my === tick.current) setError(e instanceof Error ? e.message : String(e));
      return { ok: false, cooldownRemainingMs: 0 };
    }
  }, []);

  return { ctx, error, ageMs, refresh, heal };
}
