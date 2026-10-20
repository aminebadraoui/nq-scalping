/* ------------------------------------------------------------------ *
 * Signal-time audit: for every signal event the stack emits (and every
 * vetoed candidate), stamp the GoCharting-vs-Tradovate price delta and
 * print skew at the emission instant.
 *
 * Read-only instrumentation. The signal stack already journals every
 * card (emitted or vetoed) to GC_DATA_DIR/daybook/<day>.jsonl with its
 * emission epoch ms (lib/daybook.ts DaybookSignal.at). This module tails
 * that journal, looks up the nearest GC tick (lib/live.ts 2,000-tick
 * ring) and the nearest Tradovate tick (lib/tvmd.ts ring) around each
 * `at`, and records:
 *
 *   dPrice   = GC ltp − TV tick price at that instant (pts; the error a
 *              GC-anchored level carried onto the Tradovate tape)
 *   skewMs   = GC tick ms − TV tick ms
 *
 * A short poll cadence keeps the lookups inside both rings. Nothing here
 * changes signal behavior; it only observes the already-written journal.
 * ------------------------------------------------------------------ */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { daybookDayKey, daybookFile } from "./daybook";
import { getLive, type LiveMinute } from "./live";
import { nearestHistoricTick, nearestLiveTick, type TvTick } from "./tvmd";

export interface StampedSignal {
  at: number;
  timeET: string;
  side: string;
  price: string | number; // the GC price the signal was computed on
  entry: string;
  stop: string;
  size: string;
  verdict: string;
  source: string;
  sent: boolean;
  gcLtp: number | null;
  tvPrice: number | null;
  dPrice: number | null; // pts (GC − TV)
  skewMs: number | null;
  /** tick = both feeds' tick rings; minute = TV history tick vs GC
   *  minute-bar close (older signals, coarser reference) */
  mode: "tick" | "minute" | null;
}

export interface SignalAudit {
  ok: boolean;
  day: string;
  total: number;
  stamped: number;
  signals: StampedSignal[]; // newest first, capped
  summary: {
    n: number;
    nTick: number;
    nMinute: number;
    coverage: number; // stamped / total
    medianAbsD: number | null;
    p95AbsD: number | null;
    maxAbsD: number | null;
    meanSkewMs: number | null;
  };
}

const MAX_SIGNALS = 200;
const POLL_MS = 3_000;

interface GcTick {
  ms: number;
  ltp: number;
}

function nearestGcTick(tsMs: number): GcTick | null {
  const ticks = getLive().state.ticks as GcTick[];
  let best: GcTick | null = null;
  let bestD = Infinity;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const d = Math.abs(ticks[i].ms - tsMs);
    if (d < bestD) {
      bestD = d;
      best = ticks[i];
    } else if (ticks[i].ms < tsMs - bestD) {
      break;
    }
  }
  return bestD <= 60_000 ? best : null;
}

function nearestTvTick(tsMs: number): TvTick | null {
  return nearestLiveTick(tsMs);
}

/** The GC minute bar covering tsMs (close as the price reference for
 *  older signals whose tick ring has moved on). Bars are ascending. */
function minuteBarAt(tsMs: number): LiveMinute | null {
  const bars = getLive().state.minutes;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    const closeMs = Date.parse(`${b.du ?? ""}T${b.t}:00Z`) + 60_000;
    if (!Number.isFinite(closeMs)) continue;
    if (closeMs <= tsMs + 60_000) return closeMs >= tsMs - 60_000 ? b : null;
  }
  return null;
}

const state = {
  started: false,
  day: "",
  offset: 0,
  carry: "",
  total: 0,
  signals: [] as StampedSignal[],
};

interface DaybookRow {
  t?: string;
  at?: number;
  timeET?: string;
  side?: string;
  price?: string | number;
  entry?: string;
  stop?: string;
  size?: string;
  verdict?: string;
  headline?: string;
  source?: string;
  sent?: boolean;
}

function stamp(row: DaybookRow): void {
  state.total++;
  const at = row.at ?? 0;
  const gc = nearestGcTick(at);
  const tv = nearestTvTick(at);
  let mode: StampedSignal["mode"] = null;
  let gcLtp: number | null = null;
  let tvPrice: number | null = null;
  let dPrice: number | null = null;
  let skewMs: number | null = null;
  if (gc && tv) {
    mode = "tick";
    gcLtp = gc.ltp;
    tvPrice = tv.price;
    dPrice = gc.ltp - tv.price;
    skewMs = gc.ms - tv.t;
  } else {
    // backfill older signals: exact TV tick from the day history,
    // GC minute-bar close as the coarser vendor reference
    const tvH = nearestHistoricTick(at);
    const bar = minuteBarAt(at);
    if (tvH && bar) {
      mode = "minute";
      gcLtp = bar.c;
      tvPrice = tvH.price;
      dPrice = bar.c - tvH.price;
    }
  }
  state.signals.push({
    at,
    timeET: row.timeET ?? "",
    side: row.side ?? "",
    price: row.price ?? "",
    entry: row.entry ?? "",
    stop: row.stop ?? "",
    size: row.size ?? "",
    verdict: row.verdict ?? "",
    source: row.source ?? "",
    sent: row.sent ?? false,
    gcLtp,
    tvPrice,
    dPrice,
    skewMs,
    mode,
  });
  if (state.signals.length > MAX_SIGNALS) state.signals = state.signals.slice(-MAX_SIGNALS);
}

function refresh(): void {
  const day = daybookDayKey();
  const file = daybookFile(day);
  if (!existsSync(file)) {
    if (state.day !== day) {
      state.day = day;
      state.offset = 0;
      state.carry = "";
      state.total = 0;
      state.signals = [];
    }
    return;
  }
  const size = statSync(file).size;
  if (state.day !== day || size < state.offset) {
    state.day = day;
    state.offset = 0;
    state.carry = "";
    state.total = 0;
    state.signals = [];
  }
  if (size === state.offset) return;

  let chunk = "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - state.offset);
    const n = readSync(fd, buf, 0, buf.length, state.offset);
    chunk = buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
  state.offset = size;

  const text = state.carry + chunk;
  const lines = text.split("\n");
  state.carry = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    let row: DaybookRow;
    try {
      row = JSON.parse(line) as DaybookRow;
    } catch {
      continue;
    }
    if (row.t === "signal" && typeof row.at === "number") stamp(row);
  }
}

function ensureStarted(): void {
  if (state.started) return;
  state.started = true;
  refresh();
  const timer = setInterval(() => {
    try {
      refresh();
    } catch {
      /* journal unreadable — keep last */
    }
  }, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export function getSignalAudit(): SignalAudit {
  ensureStarted();
  const stamped = state.signals.filter((s) => s.dPrice !== null);
  const abs = stamped.map((s) => Math.abs(s.dPrice!)).sort((a, b) => a - b);
  const skews = stamped.filter((s) => s.skewMs !== null).map((s) => s.skewMs!) as number[];
  return {
    ok: true,
    day: state.day,
    total: state.total,
    stamped: stamped.length,
    signals: [...state.signals].reverse().slice(0, 100),
    summary: {
      n: stamped.length,
      nTick: stamped.filter((s) => s.mode === "tick").length,
      nMinute: stamped.filter((s) => s.mode === "minute").length,
      coverage: state.total > 0 ? stamped.length / state.total : 1,
      medianAbsD: quantile(abs, 0.5),
      p95AbsD: quantile(abs, 0.95),
      maxAbsD: abs.length ? abs[abs.length - 1] : null,
      meanSkewMs: skews.length ? skews.reduce((a, b) => a + b, 0) / skews.length : null,
    },
  };
}
