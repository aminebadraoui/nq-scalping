/* ------------------------------------------------------------------ *
 * Strategy registry — the single declaration of every strategy.
 *
 * Architecture review 2026-10-11 (docs/architecture/ARCHITECTURE-REVIEW.md)
 * P0: the registry is the one home for "what a strategy IS" — its config
 * object (by reference, never a copy), its plan, its feed flag, its
 * narrative doc, and the studies that measured it.
 *
 * Rules:
 *   1. The live feed and every study already import the `*_PROD` config
 *      objects directly; the registry REFERENCES those same objects so
 *      it can never disagree with the code that trades.
 *   2. The /strategies page renders from this file — no hand-maintained
 *      prose can drift from the thresholds.
 *   3. A study that proposes a change produces a variant patch
 *      ({ config: MOM_PROD, overrides: {...} }); promotion = merging the
 *      patch here with a provenance note (EXEC_CHANGE_POLICY.md path).
 *
 * Pure data — no I/O, no env reads. Client-safe (bundled for the UI).
 * ------------------------------------------------------------------ */

import { MOM_PROD, EXP_PROD, type MomConfig, type ExpansionConfig } from "../momentum";
import { SOFT_PROD, type SoftConfig } from "../softMomentum";
import { OPEN_PROD, PULLBACK_PROD, SNIPER_PROD, type OpenDriveConfig } from "../openDrive";
import { SWEEP_RECLAIM_V2_DEFAULTS } from "../sweepReclaimV2";
import { FAMILY_LABEL } from "../familyNames";

/* ---------------- types ---------------- */

export type StrategyId =
  | "momentum_flush"
  | "momentum_expansion"
  | "rth"
  | "open_drive"
  | "open_pullback"
  | "open_sniper"
  | "sweep_reclaim"
  | "reversal";

export type StrategyStatus = "live" | "off" | "retired";

/** one display row for a config field: key, human label, doc. The VALUE is
 *  read live from the config object at render time — this table only
 *  explains fields, it can never state a number. */
export type FieldDoc = { key: string; label: string; doc: string };

export type StrategyDeclaration = {
  id: StrategyId;
  /** familyNames.ts key (FAMILY_LABEL) */
  family: string;
  status: StrategyStatus;
  /** the FEED_* env key that switches the family ("" = never wired live) */
  feedFlag: string;
  /** the code default for that flag (live feed semantics: undefined env = default) */
  feedDefault: boolean;
  /** the config object the live feed + studies use — by reference */
  config: Record<string, unknown>;
  /** provenance: which export this declaration references */
  configSource: string;
  /** how a fire becomes a live ticket: entry mode, brackets, time exit, size */
  plan: string;
  /** one-paragraph narrative of the strategy (rendered as-is on /strategies) */
  doc: string;
  /** field docs for the config table (key → label + doc) */
  fields: FieldDoc[];
  /** studies.ts ids that measured this strategy */
  studies: string[];
  /** live-only application knobs NOT in the config object (env gates etc.) */
  liveKnobs: string;
};

/* ---------------- field docs ---------------- */

const MOM_FIELDS: FieldDoc[] = [
  { key: "flushFrac", label: "Flush one-sidedness", doc: "buy fraction ≤ 0.30 for a long setup (≥70% sell); short is the mirror" },
  { key: "flushVolFloor", label: "Flush volume floor", doc: "flush bar volume ≥ max(15, min(0.5 × trailing 60-bar median, 250))" },
  { key: "failTolPts", label: "Failed-flush tolerance", doc: "the flush must make no new session extreme within this many pts" },
  { key: "breakFrac", label: "Breakout one-sidedness", doc: "breakout bar buy fraction ≥ 0.75 (mirror ≤ 0.25)" },
  { key: "breakWindow", label: "Breakout window", doc: "breakout must print within this many bars of the flush" },
  { key: "minBreakRangeR", label: "Candle-size gate", doc: "breakout bar range ≥ 1.0 × ATR14 (adopted over 0.85, 2026-10-02)" },
  { key: "needResponse", label: "Separate response bar", doc: "false = merged mode: the breakout bar itself can be the response" },
  { key: "stopMode", label: "Stop anchor", doc: "breakout = stop under the breakout bar's low − stopPad (the widen floor applies)" },
  { key: "stopPad", label: "Stop pad", doc: "points beyond the structural extreme" },
  { key: "targetR", label: "Target", doc: "1R — target = entry ± 1 × stop distance" },
  { key: "minRiskPts", label: "Min risk", doc: "stops under this never trade" },
  { key: "maxRiskPts", label: "Max risk", doc: "risk 3.5–30 pts after the widen floor" },
  { key: "riskFloorPts", label: "Widen floor", doc: "stops tighter than 3.5 pts widen to entry ∓ 3.5 (the measured sweep peak)" },
  { key: "hourFilter", label: "Hours", doc: "globex = RTH 9:30–16:00 ET excluded" },
  { key: "minGapBars", label: "Min gap", doc: "≥5 bars between signals" },
  { key: "medWindow", label: "Volume baseline", doc: "trailing 60-bar median volume" },
  { key: "volCapAbs", label: "Volume cap", doc: "volume gate capped at 250 contracts" },
];

const EXP_FIELDS: FieldDoc[] = [
  { key: "minRangeR", label: "Bar size gate", doc: "bar range ≥ 1.6 × ATR14" },
  { key: "minAbsDeltaFrac", label: "One-sidedness", doc: "|delta| ÷ volume ≥ 0.5 (≥75% one-sided)" },
  { key: "requireStack", label: "Cluster stack", doc: "≥3 price rows with ≥3 lots and ≥2:1 dominance on the trade side" },
  { key: "maxRiskPts", label: "Max risk", doc: "risk 3.5–15 pts (floor-widened)" },
  { key: "riskFloorPts", label: "Widen floor", doc: "tight stops widen to entry ∓ 3.5" },
  { key: "hourFilter", label: "Hours", doc: "globex only" },
  { key: "minGapBars", label: "Min gap", doc: "≥5 bars between signals" },
];

const RTH_FIELDS: FieldDoc[] = [
  { key: "minBuyFrac", label: "One-sidedness", doc: "buy fraction ≥ 0.60 (mirror ≤ 0.40); the A+ tier prints at ≥ 0.65" },
  { key: "volMedMult", label: "Volume gate", doc: "volume ≥ 0.5 × trailing 60-bar median" },
  { key: "stopPad", label: "Stop pad", doc: "stop under the trigger bar (1-pt pad)" },
  { key: "minRiskPts", label: "Min risk", doc: "3.5–15 pts risk (floor-widened)" },
  { key: "maxRiskPts", label: "Max risk", doc: "risk cap, pts" },
  { key: "targetR", label: "Target", doc: "0.75R — the measured optimum for the small-win RTH tape (1R version: 73.9%)" },
  { key: "minGapBars", label: "Min gap", doc: "≥5 bars between signals" },
  { key: "minClusters", label: "Footprint proof", doc: "≥3 dominant cluster rows on the trade side (≥3 lots, ≥2:1)" },
  { key: "minRangeR", label: "Candle-size gate", doc: "range ≥ 1.0 × ATR14" },
];

const OPEN_FIELDS: FieldDoc[] = [
  { key: "mode", label: "Mode", doc: "scan = first new opening extreme backed by delta; pullback; sniper; daily" },
  { key: "cumDeltaFloor", label: "Delta floor", doc: "cumulative delta from 9:30 must reach ±300" },
  { key: "minBuyFrac", label: "One-sidedness", doc: "buy fraction ≥ 0.55 (mirror ≤ 0.45)" },
  { key: "fixedTpPts", label: "Fixed target", doc: "TP +15 pts" },
  { key: "fixedSlPts", label: "Fixed stop", doc: "SL −35 pts" },
  { key: "windowMin", label: "Window", doc: "9:30–9:59 ET scan window" },
  { key: "maxRiskPts", label: "Max risk", doc: "risk ≤ 25 (pullback mode)" },
  { key: "sniperPad", label: "Sniper pad", doc: "resting limit at anchor ± 9.5" },
  { key: "sniperStop", label: "Sniper stop", doc: "stop at anchor ∓ 10" },
];

/* ---------------- declarations ---------------- */

export const STRATEGIES: StrategyDeclaration[] = [
  {
    id: "momentum_flush",
    family: "momentum_flush",
    status: "live",
    feedFlag: "FEED_MOMENTUM",
    feedDefault: true,
    config: MOM_PROD as unknown as Record<string, unknown>,
    configSource: "lib/momentum.ts MOM_PROD",
    plan:
      "Entry at the trigger bar's close · stop under that bar's low − 0.5 (widened to entry ∓ 3.5 when tighter) · target 1R · " +
      "Globex only (9:30–16:00 ET excluded) · ≥5-bar gap between signals · same-bar double-fires dedupe to one card · " +
      "the day's first card is marked 1st today. Sizing: $100 risk/trade → contracts = floor(100 ÷ (risk pts × $2)), 30-micro cap.",
    doc:
      "The failed-flush breakout: a flush bar that is ≥70% one-sided but makes NO new session extreme, followed within 10 bars " +
      "by a ≥75% one-sided breakout through the reference high (range ≥ 1.0 × ATR14). THE core live edge — validated " +
      "1,828 trades / 76.1% WR / PF 2.76 (structural 1R).",
    fields: MOM_FIELDS,
    studies: ["momentum-study", "quality-filter-sweep", "winner-loser-atlas", "hour-expectancy-study", "es-features-study", "entry-quality-study", "side-filter-study", "context-veto-stoprun", "htf-short-pullback", "counter-bias-veto", "full-gates-replay", "live-stack-exact"],
    liveKnobs: "FEED_MOMENTUM · EXP_RETRACE (limit mode on expansion) · WALL_STOP · KELLY_MODE (label only) · strategy_overrides",
  },
  {
    id: "momentum_expansion",
    family: "momentum_expansion",
    status: "live",
    feedFlag: "FEED_MOMENTUM",
    feedDefault: true,
    config: EXP_PROD as unknown as Record<string, unknown>,
    configSource: "lib/momentum.ts EXP_PROD",
    plan:
      "LIVE path: no market fill — rests a 1-pt limit behind the close for up to 5 bars (EXP_RETRACE, default ON) and rebuilds " +
      "the brackets from the fill (measured 68% WR / PF 1.29 live-style). The market-entry 78.4% / PF 3.14 numbers are " +
      "research context. Sizing: $100 budget, 30-micro cap.",
    doc:
      "The huge-bar expansion: range ≥ 1.6 × ATR14, |delta| ÷ volume ≥ 0.5, direction-matching cluster stack (≥3 rows, " +
      "≥3 lots, ≥2:1), volume gate max(15, min(0.5 × med60, 250)). Validated 4,152 sequential trades / 78.4% WR / PF 3.14.",
    fields: EXP_FIELDS,
    studies: ["expansion-study", "all-strategies-study", "retrace-slippage", "entry-quality-study", "winner-loser-atlas", "live-stack-exact"],
    liveKnobs: "FEED_MOMENTUM · EXP_RETRACE (default ON) · EXP_RETRACE_PTS/BARS (signalFeed.ts) · strategy_overrides",
  },
  {
    id: "rth",
    family: "rth",
    status: "live",
    feedFlag: "FEED_RTH",
    feedDefault: true,
    config: SOFT_PROD as unknown as Record<string, unknown>,
    configSource: "lib/softMomentum.ts SOFT_PROD",
    plan:
      "Entry at the close · stop under the bar (1-pt pad) · research optimum 0.75R target · live bracket (RTH_LIMIT_ENTRIES=1, " +
      "env): resting limit at the signal price (9-min TTL), 0.5× structural stop, 2.5R target — measured 37.7% WR / PF 1.49 " +
      "live-style. ≥5-bar gap · daily card cap (RTH_MAX_CARDS_PER_DAY) · counter-signal gate (RTH_COUNTER_GATE_*) · " +
      "crossed-stop/crossed-limit dispatch gates + approach gate (RTH_LIMIT_APPROACH_GATE_PTS=2, live 2026-10-13).",
    doc:
      "RTH soft-continuation (9:30–16:00 ET): buy-frac ≥ 0.60, ≥3 dominant cluster rows, range ≥ 1.0 × ATR14, " +
      "volume ≥ 0.5 × 60-bar median. Validated 10,325 trades / 82.2% WR / PF 3.47 at 0.75R; account sim never breaches. " +
      "The A+ tier (≥65% one-sided) prints a label, not a separate gate.",
    fields: RTH_FIELDS,
    studies: ["rth-optimizer", "rth-limit-redesign", "rth-counter-gate", "walk-forward", "gap-only-validation", "live-stack-exact"],
    liveKnobs: "FEED_RTH · RTH_LIMIT_ENTRIES · RTH_LIMIT_APPROACH_GATE_PTS · RTH_MAX_CARDS_PER_DAY · RTH_COUNTER_GATE_MIN/_PTS · RTH_PROFILE · RTH_RISK_CAP",
  },
  {
    id: "open_drive",
    family: "open_drive",
    status: "live",
    feedFlag: "FEED_OPEN_DRIVE",
    feedDefault: true,
    config: OPEN_PROD as unknown as Record<string, unknown>,
    configSource: "lib/openDrive.ts OPEN_PROD",
    plan:
      "Window 9:30–9:59 ET · fire on the first bar where high > prior window high AND cumD ≥ +300 AND buy-frac ≥ 0.55 → " +
      "LONG at the close (mirror short) · fixed TP +15 / SL −35 · sized like the momentum card ($100 budget, 30-micro cap) · " +
      "journaled separately. The fakeout (extreme without delta) is NOT traded — fading it measured negative.",
    doc:
      "The open drive scan: first new opening extreme backed by cumulative delta. Validation: 493 trades (87% of days), " +
      "96% hit at TP10/SL30, 93% at TP15/SL35, +8.3/+11.6 pts gross.",
    fields: OPEN_FIELDS,
    studies: ["gap-only-validation", "all-strategies-study", "ap-full-pool", "live-stack-exact"],
    liveKnobs: "FEED_OPEN · FEED_OPEN_DRIVE · OPEN_RISK_CAP",
  },
  {
    id: "open_pullback",
    family: "open_pullback",
    status: "off",
    feedFlag: "FEED_OPEN_PULLBACK",
    feedDefault: false,
    config: PULLBACK_PROD as unknown as Record<string, unknown>,
    configSource: "lib/openDrive.ts PULLBACK_PROD",
    plan:
      "Window 9:30–10:30 (scans from 9:46) · trend = trailing 15-bar cumD · pullback = counter bar holding the 5-bar low " +
      "with shrinking counter-delta · trigger = close back through the pullback high · entry at close · stop = pullback " +
      "low − 0.5 · target 1R · risk ≤ 25 · ≥5-bar gap. Validation: 440 trades, 69.8% WR, +5.2 pts net.",
    doc: "The morning pullback exhaustion ticket — shipped but OFF live (FEED_OPEN_PULLBACK=0).",
    fields: OPEN_FIELDS,
    studies: ["all-strategies-study", "htf-short-pullback"],
    liveKnobs: "FEED_OPEN · FEED_OPEN_PULLBACK (OFF)",
  },
  {
    id: "open_sniper",
    family: "open_sniper",
    status: "off",
    feedFlag: "FEED_OPEN_SNIPER",
    feedDefault: false,
    config: SNIPER_PROD as unknown as Record<string, unknown>,
    configSource: "lib/openDrive.ts SNIPER_PROD",
    plan:
      "Opening range = first 6 minutes (9:30–9:35) · flush within 9:36–9:45: volume ≥ max(300, 1.5 × 15-bar median), " +
      "≥55% one-sided toward the anchor, |delta| ≥ 60, holds the anchor (low ≥ anchor − 1) · resting-limit ticket: " +
      "limit at anchor ± 9.5, stop at anchor ∓ 10, target = the flush bar's extreme.",
    doc:
      "The 9:36:01 trade. Validation: longs 55.8% WR / +6.5 pts net; shorts 46.9% / +5.8; ~1 day in 11. " +
      "Shipped but OFF live (FEED_OPEN_SNIPER=0).",
    fields: OPEN_FIELDS,
    studies: ["all-strategies-study"],
    liveKnobs: "FEED_OPEN · FEED_OPEN_SNIPER (OFF)",
  },
  {
    id: "sweep_reclaim",
    family: "sweep_reclaim",
    status: "retired",
    feedFlag: "FEED_SWEEP_RECLAIM",
    feedDefault: false,
    config: SWEEP_RECLAIM_V2_DEFAULTS as unknown as Record<string, unknown>,
    configSource: "lib/sweepReclaimV2.ts SWEEP_RECLAIM_V2_DEFAULTS",
    plan: "Retired — the fade fired shorts into one-sided runs. Not wired to the live feed (studies-only).",
    doc: "Session-extreme sweep-reclaim fade. Retired live (FEED_SWEEP_RECLAIM=0); kept as provenance + research.",
    fields: [
      { key: "sweepBars", label: "Sweep window", doc: "trailing bars for the swept extreme" },
      { key: "reclaimWindow", label: "Reclaim window", doc: "bars allowed for the reclaim" },
      { key: "atrMult", label: "ATR confirmation", doc: "ATR-based confirmation multiplier" },
    ],
    studies: ["sweep-reclaim-v2"],
    liveKnobs: "FEED_SWEEP_RECLAIM (OFF)",
  },
  {
    id: "reversal",
    family: "reversal",
    status: "retired",
    feedFlag: "FEED_REVERSAL",
    feedDefault: false,
    config: {} as Record<string, unknown>,
    configSource: "lib/signals.ts cardGateOpen (box pipeline — no single config object)",
    plan:
      "The box pipeline: order-flow (location → absorption → divergence → reclaim) + price-action (premium/discount) " +
      "boxes must agree; card gate = all 3 required ingredients + ≥4/6 present + 2 footprint filters. Retired live.",
    doc:
      "The LVN reversal card — the original playbook strategy (docs/strategy/STRATEGY.md). The composer " +
      "(composeSignals / cardGateOpen) still runs for the dashboard read; no order path (FEED_REVERSAL=0).",
    fields: [],
    studies: ["reversal-vs-fakeout", "footprint-reversal"],
    liveKnobs: "FEED_REVERSAL (OFF)",
  },
];

/* ---------------- lookups ---------------- */

const byId = new Map<string, StrategyDeclaration>(STRATEGIES.map((s) => [s.id, s]));

export const strategyById = (id: StrategyId | string): StrategyDeclaration | undefined => byId.get(id);

export const liveStrategies = (): StrategyDeclaration[] => STRATEGIES.filter((s) => s.status === "live");

export const labelFor = (s: StrategyDeclaration): string => FAMILY_LABEL[s.family] ?? s.family;

/** reverse index: studies.ts study id → strategies it measured */
export function strategiesForStudy(studyId: string): StrategyDeclaration[] {
  return STRATEGIES.filter((s) => s.studies.includes(studyId));
}

/** the config field table for a declaration — value read LIVE from the object */
export function fieldRows(s: StrategyDeclaration): { key: string; label: string; doc: string; value: string }[] {
  return s.fields
    .map((f) => {
      const v = s.config[f.key];
      const value =
        v === undefined || v === null ? "—" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
      return { ...f, value };
    })
    .filter((r) => r.value !== "—");
}
