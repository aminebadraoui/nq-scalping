/* ------------------------------------------------------------------ *
 * Feature registry — the codebook as code.
 *
 * Every variable the journal records, declared once: group, role,
 * type, doc. The pattern layer consults it so the UI can:
 *   · explain any variable (doc on hover, role badge),
 *   · trust the declared type instead of heuristic sniffing,
 *   · flag DRIFT — a key in the data with no registry entry means a
 *     feature was added/renamed without updating this file (and
 *     docs/data/JOURNAL_STUDY_VARS.md, which mirrors it).
 *
 * Keys may be exact ("breakFrac") or prefixes ("dom.*", "kelly.*").
 * When a recorded key matches nothing, the explorer badges it
 * "unregistered" — the visible drift signal as features grow.
 *
 * Keep in sync with: docs/data/JOURNAL_STUDY_VARS.md,
 * lib/signalFeed.ts signalFeatures(), and the chip modules.
 * ------------------------------------------------------------------ */

export type FeatureRole = "input" | "study" | "post";
export type FeatureType = "numeric" | "categorical" | "presence" | "flag";

export type RegistryEntry = {
  key: string; // exact key, or "prefix.*" for a family of keys
  prefix?: boolean;
  group: string; // display group (featureGroups vocabulary)
  role: FeatureRole;
  type: FeatureType;
  doc: string;
};

const E = (key: string, group: string, role: FeatureRole, type: FeatureType, doc: string): RegistryEntry => ({ key, group, role, type, doc });

export const FEATURE_REGISTRY: RegistryEntry[] = [
  /* ---- SIGNAL INPUTS (what produced the card) ---- */
  E("kind", "SIGNAL INPUTS", "input", "categorical", "which trigger fired: flush (failed-flush breakout) or expansion (huge-bar)"),
  E("flushFrac", "SIGNAL INPUTS", "input", "numeric", "buy fraction of the flush bar (≤0.30 long / ≥0.70 short gate)"),
  E("flushVol", "SIGNAL INPUTS", "input", "numeric", "flush bar volume, contracts (max(15, min(0.5×med60, 250)) gate)"),
  E("flushRange", "SIGNAL INPUTS", "input", "numeric", "flush bar range, points"),
  E("failDepth", "SIGNAL INPUTS", "input", "numeric", "points the flush missed the session extreme by (>0 = failed flush)"),
  E("respFrac", "SIGNAL INPUTS", "input", "numeric", "response/breakout bar buy fraction (≥0.75 gate in MOM_PROD)"),
  E("respVol", "SIGNAL INPUTS", "input", "numeric", "response/breakout bar volume, contracts"),
  E("respDelay", "SIGNAL INPUTS", "input", "numeric", "bars between flush and breakout (≤10 gate)"),
  E("respProof", "SIGNAL INPUTS", "input", "numeric", "dominant cluster proof count at/inside the flush zone (merged mode)"),
  E("breakFrac", "SIGNAL INPUTS", "input", "numeric", "breakout bar buy fraction (momentum ≥0.75 · RTH ≥0.60, A+ ≥0.65)"),
  E("breakVol", "SIGNAL INPUTS", "input", "numeric", "breakout bar volume, contracts"),
  E("breakDelay", "SIGNAL INPUTS", "input", "numeric", "bars between flush and breakout"),
  E("refDist", "SIGNAL INPUTS", "input", "numeric", "points the breakout traded through the reference extreme"),
  E("progressPts", "SIGNAL INPUTS", "input", "numeric", "breakout high vs the session high at flush time, points"),
  E("medVol", "SIGNAL INPUTS", "input", "numeric", "trailing 60-bar median volume — the volume gate's baseline"),
  E("distVwapPts", "SIGNAL INPUTS", "input", "numeric", "close vs session VWAP (typical-price weighted), points"),
  E("cumDelta", "SIGNAL INPUTS", "input", "numeric", "session cumulative delta at entry, contracts (expansion veto + open drive gate)"),
  E("deltaFromFlush", "SIGNAL INPUTS", "input", "numeric", "cumulative delta since the flush bar, contracts"),
  E("atr14", "SIGNAL INPUTS", "input", "numeric", "median of the prior 14 bar ranges — the ATR, points"),
  E("riskPts", "SIGNAL INPUTS", "input", "numeric", "stop distance after the 3.5-pt widen floor, points (3.5–30)"),
  E("trailLowDist", "SIGNAL INPUTS", "input", "numeric", "flush low vs the trailing 20-bar swing low, points"),
  E("trailHighDist", "SIGNAL INPUTS", "input", "numeric", "trailing 20-bar swing high vs the flush high, points"),
  E("breakRangeR", "SIGNAL INPUTS", "input", "numeric", "breakout range ÷ ATR14 (momentum ≥1.0 · expansion ≥1.6 · RTH ≥1.0 gates)"),
  E("breakStack", "SIGNAL INPUTS", "input", "categorical", "dominant cluster stack side on the breakout bar: buy | sell | none"),
  E("breakVwapPos", "SIGNAL INPUTS", "input", "numeric", "breakout bar VWAP position within the bar (0..1)"),
  E("flushRangeR", "SIGNAL INPUTS", "input", "numeric", "flush range ÷ ATR14 (the quiet-before-flush check reads the prior bar's)"),
  E("deltaFrac", "SIGNAL INPUTS", "input", "numeric", "|delta| ÷ volume of the trigger bar (expansion ≥0.5 one-sidedness gate)"),
  E("domClusters", "SIGNAL INPUTS", "input", "numeric", "dominant cluster rows on the trade side (RTH ≥3 footprint proof)"),
  E("hourET", "SIGNAL INPUTS", "input", "numeric", "entry hour ET (momentum is Globex-only: 9:30–16:00 excluded)"),
  /* legacy (feeds OFF) */
  E("extreme", "SIGNAL INPUTS", "input", "numeric", "the swept session extreme, points (sweep-reclaim card — feed OFF)"),
  E("buyPct", "SIGNAL INPUTS", "input", "numeric", "reclaim bar buy percentage (sweep-reclaim card — feed OFF)"),
  E("dir", "SIGNAL INPUTS", "input", "categorical", "trade direction: long | short"),
  E("risk", "SIGNAL INPUTS", "input", "numeric", "stop distance, points (legacy key)"),

  /* ---- CARD LABELS & GATES ---- */
  E("aPlus", "CARD LABELS & GATES", "input", "flag", "the ≥65% one-sided A+ label (a LABEL — the day plan trades all cards)"),
  E("firstToday", "CARD LABELS & GATES", "input", "flag", "the day's first momentum card"),
  E("family", "CARD LABELS & GATES", "input", "categorical", "strategy family: failed_flush_breakout | huge_bar_expansion | session_continuation | open_drive | …"),
  E("gates", "CARD LABELS & GATES", "input", "presence", "active override snapshot at decision time (family.gate list)"),
  E("rejectedBy", "CARD LABELS & GATES", "input", "presence", "veto reasons when a candidate was recorded without firing"),
  E("newsBlocked", "CARD LABELS & GATES", "input", "presence", "news blackout reason when the card was skipped"),
  E("retrace", "CARD LABELS & GATES", "input", "categorical", "expansion limit-entry lifecycle: filled | expired | void | news-blocked | crossed-stop"),
  E("wallStop", "CARD LABELS & GATES", "input", "presence", "note when WALL_STOP=1 widened the stop (default OFF)"),

  /* ---- pre-trade facts re-attached from the trades row ---- */
  E("side", "SIGNAL INPUTS", "input", "categorical", "trade direction: long | short"),
  E("contracts", "SIGNAL INPUTS", "input", "numeric", "sized MNQ contracts (floor(100 ÷ risk pts × $2), 30-micro cap)"),
  E("hourBucket", "SIGNAL INPUTS", "input", "categorical", "hour block: globex_early/core/late/dawn | premkt | rth | close"),
  E("firstOfDay", "CARD LABELS & GATES", "input", "flag", "the day's first card of its family"),

  /* ---- ES cross-asset (study) ---- */
  E("esBroadConfirm", "ES CROSS-ASSET", "study", "flag", "ES printed a fresh session extreme in the 5 bars before entry"),
  E("esDelta", "ES CROSS-ASSET", "study", "categorical", "ES cumulative delta at the flush: pos | neg | flat"),
  E("esDeltaNegShort", "ES CROSS-ASSET", "study", "flag", "short card with ES cum-delta negative (the worst measured cell)"),
  E("esRs", "ES CROSS-ASSET", "study", "categorical", "relative-strength band: strong | weak | neutral"),
  E("esRsStretch", "ES CROSS-ASSET", "study", "flag", "NQ stretched against the trade direction over the past hour"),

  /* ---- seasonal (study) ---- */
  E("seasonalFomcDay", "SEASONAL", "study", "flag", "the session is a Fed decision day"),
  E("seasonalPreFomc", "SEASONAL", "study", "flag", "the trading day before a Fed decision"),
  E("seasonalHour37", "SEASONAL", "study", "flag", "entry hour inside the 3–7 ET prime window"),

  /* ---- round numbers (study) ---- */
  E("entryToRound50", "ROUND NUMBERS", "study", "numeric", "signed points from entry to its nearest 50-handle"),
  E("stopToRound50", "ROUND NUMBERS", "study", "numeric", "signed points from stop to its nearest 50-handle"),
  E("targetToRound50", "ROUND NUMBERS", "study", "numeric", "signed points from target to its nearest 50-handle"),
  E("entryAtRound", "ROUND NUMBERS", "study", "flag", "entry printed within 1 pt of a 50-handle"),
  E("stopAtRound", "ROUND NUMBERS", "study", "flag", "stop parked within 1 pt of a 50-handle (Naso's sweep-trap claim)"),
  E("targetCrossRound", "ROUND NUMBERS", "study", "flag", "a 50-handle lies inside the entry→target path"),

  /* ---- price gaps (study) ---- */
  E("sessionGaps", "PRICE GAPS", "study", "numeric", "unfilled price gaps recorded so far this session (≥1 tick)"),
  E("gapInPath", "PRICE GAPS", "study", "flag", "an unfilled gap intersects the entry→target path"),
  E("gapInPathPts", "PRICE GAPS", "study", "numeric", "points from entry to the near edge of the in-path gap"),
  E("nearestUnfilledGap", "PRICE GAPS", "study", "numeric", "points to the nearest unfilled gap on the trade side"),
  E("recentGapFill", "PRICE GAPS", "study", "flag", "a gap reached ≥50% fill within the last 30 bars"),

  /* ---- gamma walls (study) ---- */
  E("wallAhead", "GAMMA WALLS", "study", "categorical", "nearest QQQ gamma wall in the trade direction: call | put | flip"),
  E("wallDistPts", "GAMMA WALLS", "study", "numeric", "points from entry to that wall"),
  E("wallInPath", "GAMMA WALLS", "study", "flag", "the wall sits inside the profit path"),
  E("pastWall", "GAMMA WALLS", "study", "flag", "price already traded through the directional wall"),

  /* ---- kelly (study, KELLY_MODE=1 only) ---- */
  { key: "kelly.*", prefix: true, group: "KELLY", role: "study", type: "numeric", doc: "the journal-only Kelly chip: n/p/b/f/fRef/ratio/risk/skip/family/window/priorWr — sizing stays flat unless KELLY_LIVE_USE=1" },

  /* ---- dom evidence (study) ---- */
  { key: "dom.*", prefix: true, group: "DOM EVIDENCE", role: "study", type: "presence", doc: "iceberg candidates vs the ticket at signal time (candidates / nearEntry / nearStop / nearTarget, NQ + ES) — observational only" },

  /* ---- post-hoc anatomy ---- */
  E("drift", "ANATOMY (post-hoc)", "post", "numeric", "entry adverse drift: points the tape ran against the entry before the fill"),
  E("heldMin", "ANATOMY (post-hoc)", "post", "numeric", "minutes held, fill to final exit"),
  E("mfe", "ANATOMY (post-hoc)", "post", "numeric", "max favorable excursion, points"),
  E("mae", "ANATOMY (post-hoc)", "post", "numeric", "max adverse excursion, points"),
  E("stopRun", "ANATOMY (post-hoc)", "post", "flag", "loss stopped out by ≤ a few ticks past the stop (the sweep)"),
  E("targetReached", "ANATOMY (post-hoc)", "post", "flag", "tape reached the target before the stop"),
  E("recovered", "ANATOMY (post-hoc)", "post", "flag", "after a deep adverse drift, the trade still won"),
  E("lossLabel", "ANATOMY (post-hoc)", "post", "categorical", "the loss-class label: stop-run | never worked | gave back"),
];

const byExact = new Map(FEATURE_REGISTRY.filter((e) => !e.prefix).map((e) => [e.key, e]));
const prefixes = FEATURE_REGISTRY.filter((e) => e.prefix).map((e) => e.key.slice(0, -1));

export type RegistryHit = { registered: boolean; entry: RegistryEntry | null };

/** exact match first, then prefix families ("kelly.*", "dom.*") */
export function lookupFeature(key: string): RegistryHit {
  const exact = byExact.get(key);
  if (exact) return { registered: true, entry: exact };
  const base = key.split(".")[0];
  for (const p of prefixes) {
    if (p === `${base}.` || key.startsWith(p)) return { registered: true, entry: FEATURE_REGISTRY.find((e) => e.key === `${p}*`) ?? null };
  }
  return { registered: false, entry: null };
}

/** keys present in the data but absent from the registry — the drift signal */
export function driftKeys(keys: string[]): string[] {
  return keys.filter((k) => !lookupFeature(k).registered);
}
