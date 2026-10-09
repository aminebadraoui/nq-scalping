/* ------------------------------------------------------------------ *
 * Feature grouping — the classified view of a signal's feature vector.
 *
 * Every recorded trade feature (signals.features jsonb, flattened to
 * dotted paths by lib/tradeLedger.ts flattenFeatures) is bucketed into
 * ordered, labeled groups so a surface can answer one question at a
 * glance: WHAT MADE THE SIGNAL vs WHAT WAS ONLY OBSERVED.
 *
 *   role "signal" — read by the detector/gate that produced the card
 *   role "study"  — tracked at fire time, never read by any gate
 *
 * The classification mirrors docs/data/JOURNAL_STUDY_VARS.md; keep the
 * two in sync when a feature is added or moved. Pure + client-safe.
 * ------------------------------------------------------------------ */

export type FeatureRole = "signal" | "study";

export type FeatureGroup = {
  /** stable group key (ordering + tests) */
  key: string;
  /** display label */
  label: string;
  role: FeatureRole;
  /** one-line explanation shown under the group heading */
  note: string;
  /** [flattened path, value] pairs, sorted by path */
  entries: Array<[string, unknown]>;
};

/** the detector's decision inputs (the signalFeatures whitelist in
 *  lib/signalFeed.ts + the two 2026-10-08 journal additions) */
const SIGNAL_INPUT_KEYS = new Set([
  "kind", "flushFrac", "flushVol", "flushRange", "failDepth",
  "respFrac", "respVol", "respDelay", "respProof",
  "breakFrac", "breakVol", "breakDelay", "refDist", "progressPts",
  "medVol", "distVwapPts", "cumDelta", "deltaFromFlush",
  "atr14", "riskPts", "trailLowDist", "trailHighDist",
  "breakRangeR", "breakStack", "breakVwapPos", "flushRangeR",
  "deltaFrac", "domClusters", "hourET", "extreme", "buyPct", "dir", "risk",
]);

/** card-level decision context (labels, vetoes, lifecycle) */
const LABEL_GATE_KEYS = new Set([
  "aPlus", "firstToday", "family", "gates", "rejectedBy", "newsBlocked",
  "retrace", "wallStop", "drift",
]);

/** round-number (Naso) chips — journal-only */
const ROUND_KEYS = new Set([
  "entryToRound50", "stopToRound50", "targetToRound50",
  "entryAtRound", "stopAtRound", "targetCrossRound",
]);

/** price-gap (Naso) chips — journal-only */
const GAP_KEYS = new Set([
  "sessionGaps", "gapInPath", "gapInPathPts", "nearestUnfilledGap", "recentGapFill",
]);

/** gamma-wall chips — journal-only (degrade silently without an options snapshot) */
const WALL_KEYS = new Set(["wallAhead", "wallDistPts", "wallInPath", "pastWall"]);

export const GROUP_ORDER: Array<{
  key: string;
  label: string;
  role: FeatureRole;
  note: string;
}> = [
  { key: "signal", label: "SIGNAL INPUTS", role: "signal", note: "the numbers behind the card's gates — this is what produced the signal" },
  { key: "labels", label: "CARD LABELS & GATES", role: "signal", note: "labels, veto reasons, override snapshot and limit-entry lifecycle at decision time" },
  { key: "es", label: "ES CROSS-ASSET", role: "study", note: "ES twin context — journal-only chips, never gates" },
  { key: "seasonal", label: "SEASONAL", role: "study", note: "calendar facts (FOMC / pre-FOMC / hour window) — journal-only chips" },
  { key: "round", label: "ROUND NUMBERS", role: "study", note: "50-handle proximity of entry/stop/target (Naso hypotheses) — journal-only" },
  { key: "gaps", label: "PRICE GAPS", role: "study", note: "unfilled price-gap inventory vs the trade path (Naso hypotheses) — journal-only" },
  { key: "walls", label: "GAMMA WALLS", role: "study", note: "nearest QQQ gamma wall in NQ points — forward-logged evidence only" },
  { key: "kelly", label: "KELLY", role: "study", note: "the journal-only edge chip (KELLY_MODE=1) — sizing stays flat unless KELLY_LIVE_USE=1" },
  { key: "dom", label: "DOM EVIDENCE", role: "study", note: "iceberg candidates vs entry/stop/target at signal time — observational only" },
  { key: "other", label: "OTHER", role: "study", note: "everything else recorded at signal time" },
];

/** classify one flattened path (exact key first, then prefix families) */
export function groupKeyOf(path: string): string {
  const base = path.split(".")[0];
  if (SIGNAL_INPUT_KEYS.has(base)) return "signal";
  if (LABEL_GATE_KEYS.has(base)) return "labels";
  if (base.startsWith("es")) return "es";
  if (base.startsWith("seasonal")) return "seasonal";
  if (ROUND_KEYS.has(base)) return "round";
  if (GAP_KEYS.has(base)) return "gaps";
  if (WALL_KEYS.has(base)) return "walls";
  if (base.startsWith("kelly")) return "kelly";
  if (base.startsWith("dom")) return "dom";
  return "other";
}

/** bucket a flattened feature map into the ordered, labeled groups.
 *  Groups with no entries are omitted; entries are sorted by path. */
export function groupFeatures(flat: Record<string, unknown> | null | undefined): FeatureGroup[] {
  const out: FeatureGroup[] = [];
  if (!flat || typeof flat !== "object") return out;
  const byKey = new Map<string, Array<[string, unknown]>>();
  for (const [k, v] of Object.entries(flat)) {
    if (v === undefined || v === null) continue;
    const g = groupKeyOf(k);
    const arr = byKey.get(g) ?? [];
    arr.push([k, v]);
    byKey.set(g, arr);
  }
  for (const def of GROUP_ORDER) {
    const entries = byKey.get(def.key);
    if (!entries || !entries.length) continue;
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    out.push({ key: def.key, label: def.label, role: def.role, note: def.note, entries });
  }
  return out;
}
