/* ------------------------------------------------------------------ *
 * Detector + footprint memoization for the LIVE tick loop.
 *
 * The three heavy checks (momentum, RTH, open drive) each recompute
 * full-session prefix passes (VWAP, cumulative delta, trailing medians)
 * over the whole minutes array on every tick — measured p50 ~29/24/22ms
 * per check. These are pure functions of the footprint array, so the
 * results are memoized per bar state:
 *
 *   · the footprint conversion (liveMinutesToFootprint, O(n) per tick)
 *     is cached per (minutes array identity, barsRevision)
 *   · each detector output is cached per (fp identity, barsRevision,
 *     length, tail signature)
 *
 * barsRevision (lib/live.ts) bumps every time a candle merge REPLACES or
 * ADDS a bar — the vendor candles revise the lossy tick-built bars
 * mid-array, which changes the prefix math, so any revision invalidates
 * every cache entry. Outputs are IDENTICAL to fresh computation by
 * construction (same inputs → same outputs; recompute on any change) —
 * verified over the archive by scripts/detectorCacheValidation.ts.
 * ------------------------------------------------------------------ */

import { liveMinutesToFootprint } from "./signalEngine";
import type { FootprintMinute } from "./gcdata";
import type { LiveMinute } from "./live";
import { detectMomentum, detectExpansionScalp, type MomConfig, type ExpansionConfig, type MomentumSignal } from "./momentum";
import { detectSoftMomentum, type SoftConfig } from "./softMomentum";
import { detectOpenDrive, type OpenDriveConfig } from "./openDrive";

/* ---- footprint conversion cache (the getData stage) ------------------ */

let fpCache: { minutes: LiveMinute[]; revision: number; fp: FootprintMinute[] } | null = null;

/** the live minutes → footprint conversion, cached per buffer revision.
 *  Returns the SAME array on hit — consumers must treat it as read-only
 *  (every consumer in the tick loop already does; the conversion itself
 *  builds fresh objects). When `cur` (the developing minute) is given, it
 *  is converted separately (O(1)) and appended to a FRESH array — the
 *  developing bar mutates every tick, so it can never sit in the cache. */
export function cachedFootprint(minutes: LiveMinute[], revision: number, cur?: LiveMinute | null): FootprintMinute[] {
  let c = fpCache;
  if (!c || c.minutes !== minutes || c.revision !== revision) {
    c = { minutes, revision, fp: liveMinutesToFootprint(minutes) };
    fpCache = c;
  }
  if (!cur) return c.fp;
  return [...c.fp, ...liveMinutesToFootprint([cur])];
}

/* ---- per-detector memoization ----------------------------------------- */

const momCache = new WeakMap<FootprintMinute[], { key: string; out: MomentumSignal[] }>();
const expCache = new WeakMap<FootprintMinute[], { key: string; out: MomentumSignal[] }>();
const rthCache = new WeakMap<FootprintMinute[], { key: string; out: MomentumSignal[] }>();
const openCache = new WeakMap<FootprintMinute[], { key: string; out: MomentumSignal[] }>();

/** cache key: any bar revision, length change, or tail change invalidates */
function keyOf(fp: FootprintMinute[], revision: number): string {
  const n = fp.length;
  if (!n) return `${revision}|0`;
  const t = fp[n - 1];
  return `${revision}|${n}|${t.t}|${t.d}|${t.src ?? ""}|${t.buy}|${t.sell}|${t.high}|${t.low}|${t.c}|${t.o}`;
}

export function detectMomentumMemo(fp: FootprintMinute[], cfg: MomConfig, revision: number): MomentumSignal[] {
  const key = keyOf(fp, revision);
  const hit = momCache.get(fp);
  if (hit && hit.key === key) return hit.out;
  const out = detectMomentum(fp, cfg);
  momCache.set(fp, { key, out });
  return out;
}

export function detectExpansionScalpMemo(fp: FootprintMinute[], cfg: ExpansionConfig, revision: number): MomentumSignal[] {
  const key = keyOf(fp, revision);
  const hit = expCache.get(fp);
  if (hit && hit.key === key) return hit.out;
  const out = detectExpansionScalp(fp, cfg);
  expCache.set(fp, { key, out });
  return out;
}

export function detectSoftMomentumMemo(fp: FootprintMinute[], cfg: SoftConfig, revision: number): MomentumSignal[] {
  const key = keyOf(fp, revision);
  const hit = rthCache.get(fp);
  if (hit && hit.key === key) return hit.out;
  const out = detectSoftMomentum(fp, cfg);
  rthCache.set(fp, { key, out });
  return out;
}

export function detectOpenDriveMemo(fp: FootprintMinute[], cfg: OpenDriveConfig, revision: number): MomentumSignal[] {
  const key = keyOf(fp, revision);
  const hit = openCache.get(fp);
  if (hit && hit.key === key) return hit.out;
  const out = detectOpenDrive(fp, cfg);
  openCache.set(fp, { key, out });
  return out;
}

/** TEST ONLY: reset all caches. */
export function __resetDetectorCacheForTest(): void {
  fpCache = null;
}
