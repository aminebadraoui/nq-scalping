"use client";

/* Polls /api/macro-interpret for the Macro tab's interpretation row.
 * The route owns generation + cooldown; this hook is a slow 10-min
 * poller (the row regenerates daily) with a 5s fast-poll while a
 * manual refresh is in flight. Display-only — no signal code imports
 * this. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { InterpretRow } from "@/lib/macroInterpret";
import { adminFetch } from "@/lib/adminFetch";

export type InterpretLoad = { row: InterpretRow | null; error: string | null; cooldownMs: number };

const POLL_MS = 10 * 60_000;
const FAST_POLL_MS = 5_000;
const REFRESH_TIMEOUT_MS = 25_000;

export function useMacroInterpret(): { load: InterpretLoad; refresh: () => void; refreshing: boolean } {
  const [load, setLoad] = useState<InterpretLoad>({ row: null, error: null, cooldownMs: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [fast, setFast] = useState(false);
  const seenGenAt = useRef<string | null>(null);

  const fetchRow = useCallback(async () => {
    try {
      const r = await fetch("/api/macro-interpret");
      const j = (await r.json()) as { ok?: boolean; interpretation: InterpretRow | null; cooldownRemainingMs?: number };
      const row = j.interpretation ?? null;
      if (fast && row && seenGenAt.current && row.generated_at !== seenGenAt.current) {
        setFast(false); // the refresh landed — back to the slow poll
      }
      seenGenAt.current = row?.generated_at ?? null;
      setLoad({ row, error: null, cooldownMs: j.cooldownRemainingMs ?? 0 });
    } catch (e) {
      setLoad((cur) => ({ ...cur, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [fast]);

  useEffect(() => {
    fetchRow();
    const id = setInterval(fetchRow, fast ? FAST_POLL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [fetchRow, fast]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFast(true);
    try {
      // the generation can take minutes on a cold macro cache; don't block
      // on it — the fast poll above picks the new row up as soon as it lands.
      const r = await adminFetch("/api/macro-interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      const j = (await r.json()) as { ok?: boolean; interpretation: InterpretRow | null; cooldown?: boolean; cooldownRemainingMs?: number };
      if (j.interpretation) {
        seenGenAt.current = j.interpretation.generated_at;
        setLoad({ row: j.interpretation, error: null, cooldownMs: j.cooldownRemainingMs ?? 0 });
        setFast(false);
      } else if (j.cooldown) {
        setLoad((cur) => ({ ...cur, cooldownMs: j.cooldownRemainingMs ?? 0 }));
        setFast(false);
      }
    } catch {
      /* the poll will surface whatever landed */
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  return { load, refresh, refreshing };
}
