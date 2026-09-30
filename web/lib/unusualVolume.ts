/* ------------------------------------------------------------------ *
 * Unusual-volume alert context + pullback watch.
 *
 * Stage 1 (the alert) gets four pieces of context that the raw 70/30
 * volume split lacks:
 *   · the alert bar's POC and its migration vs the previous bar — did
 *     value move WITH the bar (initiative) or stall against it?
 *   · the close position in the bar's range — a one-sided bar closing
 *     off its extreme is exhaustion, not initiative.
 *   · the bar's stacked imbalance (the imbalance engine's 3:1 rows) —
 *     a stack WITH the move is fuel, AGAINST it is absorption.
 *   · the nearest reference level (POC / VAH / VAL / LVN edge) — the
 *     "decision point" question the whole strategy is built on.
 *
 * Stage 2 (the watch) turns the alert into a two-stage sequence:
 *   alert bar → first aggressive counter-side bar (pullback starting)
 *   → flush of the pullback extreme reclaimed one-sidedly (pullback
 *   over). The reclaim mirrors detectOneSidedReclaim's shape but is
 *   anchored at the PULLBACK extreme instead of the session extreme —
 *   a pullback after a fresh high never revisits the session low, so
 *   the session-extreme detector cannot see it.
 *
 * Pure + client-safe: only imports the imbalance engine.
 * ------------------------------------------------------------------ */

import { imbalanceFor, summarizeImb } from "./imbalance";

/** price-keyed footprint cells: "20,405.25" -> [buy, sell] (the LiveMinute shape) */
export type PriceLevels = Record<string, [number, number]>;

/** structural slice of signalEngine.Level — enough to answer "nearest level" */
export type UVLevelInput = {
  label: string;
  poc: number;
  vah: number;
  val: number;
  lvns: [number, number][];
};

export type UVLevelRef = {
  label: string;
  kind: "POC" | "VAH" | "VAL" | "LVN";
  value: number;
  dist: number; // pts, always >= 0
};

export function levelsToRows(levels?: PriceLevels | null): { price: number; buy: number; sell: number }[] {
  return Object.entries(levels ?? {})
    .map(([p, v]) => ({ price: Number(p), buy: v[0], sell: v[1] }))
    .sort((a, b) => b.price - a.price);
}

/** the alert bar's point of control: the tick that printed the most volume */
export function barPocOf(levels?: PriceLevels | null): { price: number; vol: number } | null {
  let best: { price: number; vol: number } | null = null;
  for (const [p, v] of Object.entries(levels ?? {})) {
    const vol = v[0] + v[1];
    if (!best || vol > best.vol) best = { price: Number(p), vol };
  }
  return best;
}

/** POC migration vs the previous bar, in ticks (+ = up). Null when a POC is missing. */
export function pocStepTicks(prevPoc: number | null, poc: number | null): number | null {
  if (prevPoc === null || poc === null || !Number.isFinite(prevPoc) || !Number.isFinite(poc)) return null;
  return Math.round((poc - prevPoc) * 4);
}

/** where the close sits in the bar's range: 0 = low, 1 = high. Null without OHLC or a flat range. */
export function closePosOf(high: number, low: number, close: number): number | null {
  if (!(close > 0) || !(high > low)) return null;
  return (close - low) / (high - low);
}

/** the alert bar's stacked imbalance (3+ consecutive same-side rows, >=3:1, >=10 ct) */
export function barImbOf(
  levels?: PriceLevels | null,
): { side: "buy" | "sell"; len: number; from: number; to: number } | null {
  const rows = levelsToRows(levels);
  if (!rows.length) return null;
  return summarizeImb(imbalanceFor(rows)).stacked;
}

/** nearest reference level (POC / VAH / VAL / LVN edge) within maxPts */
export function nearestLevelOf(levels: UVLevelInput[], price: number, maxPts: number): UVLevelRef | null {
  if (!Number.isFinite(price)) return null;
  let best: UVLevelRef | null = null;
  const consider = (label: string, kind: UVLevelRef["kind"], value: number) => {
    if (!Number.isFinite(value)) return;
    const dist = Math.abs(value - price);
    if (dist <= maxPts && (!best || dist < best.dist)) best = { label, kind, value, dist };
  };
  for (const l of levels) {
    consider(l.label, "POC", l.poc);
    consider(l.label, "VAH", l.vah);
    consider(l.label, "VAL", l.val);
    for (const [a, b] of l.lvns) {
      consider(l.label, "LVN", a);
      consider(l.label, "LVN", b);
    }
  }
  return best;
}

/* ---------------- pullback watch (stage 2) ---------------- */

export type UVWatchMinute = {
  t: string;
  high: number;
  low: number;
  buy: number;
  sell: number;
  c?: number;
};

export type UVWatch = {
  /** the alert bar's dominant side */
  side: "buy" | "sell";
  /** alert bar extremes — a full retrace of the bar cancels the watch */
  high: number;
  low: number;
  /** index of the alert bar in the live minutes array (append-only) */
  armedIdx: number;
  armedAt: number;
  started: boolean;
  /** index of the pullback-start bar once it prints */
  startIdx: number;
  /** the pullback's own extreme: its low after a buy alert / high after a sell alert */
  pullExtreme: number;
};

export type UVWatchResult =
  | { kind: "start"; t: string; flipTo: "down" | "up"; deltaPct: number; idx: number; pullExtreme: number; price: number }
  | {
      kind: "reclaim";
      t: string;
      dir: "long" | "short";
      entry: number;
      stop: number;
      target: number;
      buyPct: number;
      swept: number;
    }
  | { kind: "cancelled"; reason: string }
  | { kind: "expired" }
  | null;

/** story.ts delta-flip floor — an aggressive bar must move >=15% of its volume */
const FLIP_MIN = 0.15;
/** detectOneSidedReclaim's one-sidedness gate for the reclaim bar */
const RECLAIM_ONENESS = 0.65;
/** detectOneSidedReclaim's sweep depth (1 tick) */
const SWEEP_TICK = 0.25;
/** detectOneSidedReclaim's stop pad beyond the swept extreme */
const STOP_PAD = 0.5;

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function deltaPct(buy: number, sell: number): number {
  const v = buy + sell;
  return v > 0 ? (buy - sell) / v : 0;
}

/**
 * Advance the pullback watch by one loop pass. Mutates nothing except what the
 * caller commits (w.started / w.startIdx / w.pullExtreme) when a "start" event
 * is returned — the function itself only reads the watch.
 */
export function uvWatchCheck(w: UVWatch, minutes: UVWatchMinute[], now: number, windowMs: number): UVWatchResult {
  const n = minutes.length;
  if (now - w.armedAt > windowMs) return { kind: "expired" };

  const volMed = Math.max(50, median(minutes.map((m) => m.buy + m.sell)));

  // two consecutive bars trading past the WHOLE alert bar (by mid) = the move
  // reversed, no pullback setup left. A single bar past it is just a deep
  // flush, which is exactly what the reclaim below is watching for.
  let pastRun = 0;
  for (let i = w.armedIdx + 1; i < n; i++) {
    const m = minutes[i];
    const mid = (m.high + m.low) / 2;
    const past = w.side === "buy" ? mid < w.low : mid > w.high;
    pastRun = past ? pastRun + 1 : 0;
    if (pastRun >= 2) return { kind: "cancelled", reason: "two bars traded past the whole alert bar — the move reversed" };

    if (!w.started) {
      const dp = deltaPct(m.buy, m.sell);
      const against = w.side === "buy" ? dp <= -FLIP_MIN : dp >= FLIP_MIN;
      if (!against) continue;
      const pullExtreme = w.side === "buy" ? m.low : m.high;
      const price = m.c && m.c > 0 ? m.c : (m.high + m.low) / 2;
      return { kind: "start", t: m.t, flipTo: w.side === "buy" ? "down" : "up", deltaPct: dp, idx: i, pullExtreme, price };
    }

    // the flush must come AFTER the pullback started — a pre-start bar's low is
    // part of the move that created the pullback, not a flush of it
    if (i <= w.startIdx) continue;

    // pullback underway: a flush of the pullback extreme, then a one-sided
    // reclaim back inside within 2 bars — the same shape as the sweep-reclaim
    // feed, but anchored at the PULLBACK extreme (a fresh-high alert never
    // revisits the session low, so the session-anchored detector can't see it)
    const swept = w.side === "buy" ? m.low <= w.pullExtreme - SWEEP_TICK : m.high >= w.pullExtreme + SWEEP_TICK;
    if (!swept) continue;
    for (let j = i + 1; j < Math.min(n, i + 3); j++) {
      const b = minutes[j];
      const mid = (b.high + b.low) / 2;
      const backInside = w.side === "buy" ? mid > w.pullExtreme : mid < w.pullExtreme;
      if (!backInside) break;
      // the reclaim bar must be the LAST completed minute — no lookahead, no repaint
      if (j !== n - 1) break;
      const tot = b.buy + b.sell;
      const bp = tot > 0 ? b.buy / tot : 0.5;
      const oneSided = w.side === "buy" ? bp >= RECLAIM_ONENESS : bp <= 1 - RECLAIM_ONENESS;
      if (!oneSided) break;
      if (tot < volMed) break;
      const entry = b.c && b.c > 0 ? b.c : mid;
      const stop = w.side === "buy" ? w.pullExtreme - STOP_PAD : w.pullExtreme + STOP_PAD;
      const risk = Math.abs(entry - stop);
      if (risk <= 0) break;
      return {
        kind: "reclaim",
        t: b.t,
        dir: w.side === "buy" ? "long" : "short",
        entry,
        stop,
        target: w.side === "buy" ? entry + risk : entry - risk,
        buyPct: bp,
        swept: w.pullExtreme,
      };
    }
  }
  return null;
}
