/* ------------------------------------------------------------------ *
 * Sweep-reclaim + one-sided confirmation — the 67%-win scalp setup.
 *
 * Shared between the server signal feed (lib/signalFeed.ts → Telegram)
 * and the dashboard (SweepReclaimPanel) so the two can never drift.
 * Client-safe: only imports the timezone helper.
 * ------------------------------------------------------------------ */

import { cdtToET } from "./times";

export type ReclaimMinute = {
  t: string; // feed clock "HH:mm"
  d?: string; // feed calendar date
  high: number;
  low: number;
  buy: number;
  sell: number;
  c?: number; // close (0 when no OHLC)
};

export type ReclaimSetup = {
  dir: "long" | "short";
  /** the swept swing extreme (the stop's reference) */
  extreme: number;
  /** entry = the reclaim bar's close (or mid when no OHLC) */
  entry: number;
  stop: number;
  target: number;
  risk: number;
  /** buy share of the reclaim bar's volume (0..1) — the confirmation */
  buyPct: number;
  /** feed-clock "HH:mm" of the reclaim bar (dedupe key) */
  t: string;
  timeET: string;
  day: string;
};

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * Detect a completed sweep-reclaim whose reclaim bar was strongly one-sided in
 * the entry direction. Fires only when the reclaim bar is the LAST completed
 * minute (the bar's buy/sell is final — no lookahead, no repaint).
 * Volume ≥ session median AND ≥65% on the entry side; stop 0.5pt beyond the
 * swept extreme; target 1R.
 */
export function detectOneSidedReclaim<T extends ReclaimMinute>(minutes: T[]): ReclaimSetup | null {
  const n = minutes.length;
  if (n < 3) return null;
  const lo = minutes.map((m) => m.low);
  const hi = minutes.map((m) => m.high);
  const mid = minutes.map((m) => (m.high + m.low) / 2);
  const vol = minutes.map((m) => m.buy + m.sell);
  const med = Math.max(50, median(vol));

  let runLo = Infinity;
  let runHi = -Infinity;
  for (let i = 1; i < n; i++) {
    const pl = Math.min(runLo, lo[i - 1]);
    const ph = Math.max(runHi, hi[i - 1]);
    runLo = pl;
    runHi = ph;

    if (lo[i] <= pl - 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) {
        if (mid[j] > pl) {
          if (j === n - 1) {
            const bar = minutes[j];
            const total = bar.buy + bar.sell;
            const buyPct = total > 0 ? bar.buy / total : 0.5;
            if (total >= med && buyPct >= 0.65) {
              const entry = bar.c && bar.c > 0 ? bar.c : mid[j];
              const stop = pl - 0.5;
              const risk = entry - stop;
              if (risk > 0) {
                return {
                  dir: "long", extreme: pl, entry, stop, target: entry + risk, risk, buyPct,
                  t: bar.t, timeET: cdtToET(bar.t), day: bar.d ?? "",
                };
              }
            }
          }
          break;
        }
      }
    }

    if (hi[i] >= ph + 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) {
        if (mid[j] < ph) {
          if (j === n - 1) {
            const bar = minutes[j];
            const total = bar.buy + bar.sell;
            const buyPct = total > 0 ? bar.buy / total : 0.5;
            if (total >= med && buyPct <= 0.35) {
              const entry = bar.c && bar.c > 0 ? bar.c : mid[j];
              const stop = ph + 0.5;
              const risk = stop - entry;
              if (risk > 0) {
                return {
                  dir: "short", extreme: ph, entry, stop, target: entry - risk, risk, buyPct,
                  t: bar.t, timeET: cdtToET(bar.t), day: bar.d ?? "",
                };
              }
            }
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Running swing low/high of the session so far (the two levels to watch). */
export function swingLevels<T extends ReclaimMinute>(minutes: T[]): { low: number; high: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of minutes) {
    lo = Math.min(lo, m.low);
    hi = Math.max(hi, m.high);
  }
  return { low: Number.isFinite(lo) ? lo : 0, high: Number.isFinite(hi) ? hi : 0 };
}
