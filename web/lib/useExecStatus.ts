"use client";

import { useEffect, useState } from "react";
import type { PipelineExtras } from "./pipelineHealth";

/** the /api/gc?action=health payload — display-only execution status */
export type ExecHealth = {
  ok: boolean;
  now: string;
  execution: {
    crosstradeConfigured: boolean;
    tradingHalt: boolean;
    account: string | null;
    instrument: string;
    executeLive: boolean;
    protections: {
      status: { state: "live" | "dry" | "halted" | "watch"; label: string; reason: string; halts: string[] };
      stage: "eval" | "funded";
      floor: number;
      highWater: number;
      locked: boolean;
      dayKey: string;
      dayPnl: number;
      dayPeak: number;
      consistencyCap: number;
      dailyFloor: number;
      profitArm: number;
      profitArmed: boolean;
      lastDayPnl: number | null;
      dd: { hi: number; lo: number; halved: boolean };
      tiers: unknown[];
      account: { equity: number; realized: number } | null;
    } | null;
    feeds: Record<string, boolean>;
    liveFeed: {
      connected: boolean;
      minutes: number;
      lastTradeAgeSec: number | null;
      lastVolChangeAgeSec: number | null;
      ratio: number | null;
      barSource: { candle: number; tick: number } | null;
      confirmRace: {
        fastDispatch: boolean;
        active: boolean;
        races: number;
        restWins: number;
        frameWins: number;
        lastRestConfirmMs: number;
        lastFrameConfirmMs: number;
      } | null;
      heal: { step: number; episodes: number } | null;
      tapeGate: {
        totalBars: number;
        tail: number;
        tailAgeMs: number | null;
        hold: boolean;
        veto: boolean;
        lastBarClose: number | null;
      } | null;
      detectors: { bars: number; momentumFlush: number; momentumExpansion: number; rth: number } | null;
    } | null;
    domFeed: {
      connected: boolean;
      frames: number;
      silentConnects: number;
      lastReconnectAt: number;
      nqSnapshots: number;
      nqIncrements: number;
    } | null;
    market: { open: boolean; sessionDay: string; next: { kind: string; atMs: number } } | null;
    /** the health-pipeline extras (signal card / latency / exec ledger) */
    pipeline: PipelineExtras | null;
  } | null;
};

/** poll the live status every `intervalMs` (20s default); pauses in
 *  hidden tabs and re-polls on visibility */
export function useExecStatus(intervalMs = 20_000): ExecHealth | null {
  const [h, setH] = useState<ExecHealth | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const r = await fetch("/api/gc?action=health", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as ExecHealth;
          if (!stop) setH(j);
        }
      } catch {
        /* keep the last snapshot */
      }
      if (!stop) timer = setTimeout(load, intervalMs);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
  return h;
}
