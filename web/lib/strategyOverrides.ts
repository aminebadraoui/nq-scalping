/* ------------------------------------------------------------------ *
 * Strategy overrides — the self-improvement actuator.
 *
 * The insight miner proposes gate changes; an approved proposal lands
 * as a row in `strategy_overrides`. The live signal feed consults this
 * module before every card: decideSignal() applies the overrides to the
 * detector's output (family enable, hour veto, trend filter, min break
 * fraction / range, max risk, first-of-day only). The feed keeps a
 * short cache and re-reads every few minutes, so an approved override
 * goes live WITHOUT a deploy — that is the self-improving loop:
 *
 *   signals + fills → anatomy + insights → proposed gates
 *        → (human approve or SELF_IMPROVE=1) → strategy_overrides
 *        → decideSignal() filters the next card.
 *
 * Everything defaults to OFF: no override = current behavior. The pure
 * decision function is unit-tested; the DB loader is best-effort (a DB
 * hiccup never blocks a card — it falls back to the last cache).
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { withTimeout } from "./asyncTimeout";
import { canonicalFamily } from "./strategies/aliases";

export type Override = {
  id: number;
  family: string;
  gate: string;
  value: unknown;
};

let cache: Override[] | null = null;
let loadedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

function parseValue(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return { value: v };
}

/** Load active overrides (cached ~5 min). Best-effort: failures return the
 *  last known cache or an empty list — never throws. */
export async function getOverrides(): Promise<Override[]> {
  if (cache && Date.now() - loadedAt < CACHE_MS) return cache;
  if (!dbEnabled()) return cache ?? [];
  try {
    const rows = await withTimeout(
      getDb()`select id, family, gate, value from strategy_overrides where active = true`,
      3_000,
      "strategy overrides load",
    );
    cache = rows.map((r) => ({
      id: Number(r.id),
      family: String(r.family),
      gate: String(r.gate),
      value: r.value as unknown,
    }));
    loadedAt = Date.now();
    return cache;
  } catch {
    return cache ?? [];
  }
}

export type GateContext = {
  /** family labels to match, specific → general (e.g. ["huge_bar_expansion","momentum","all"]) */
  families: string[];
  hourET: number; // 0-23 New York
  side: "long" | "short";
  breakFrac: number; // 0..1 one-sided share of the trigger bar
  riskPts: number;
  breakRangeR: number | null;
  cumDelta: number | null; // session cumulative delta at entry
  firstOfDay: boolean;
  /** trigger-bar aligned trade-count fraction (bT/(bT+sT) for longs,
   *  mirror shorts). Optional + null = the live tape does not supply
   *  counts yet — the min_count_frac gate FAILS OPEN on it. */
  countFrac?: number | null;
};

export type GateDecision = { allow: boolean; reasons: string[] };

const numOf = (v: unknown, fallback: number | null = null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? n : fallback;
};

/**
 * Apply the active overrides to one detected signal. Matches an override
 * when its family is in ctx.families. Returns the decision + human reasons.
 */
export function decideSignal(ovs: Override[], ctx: GateContext): GateDecision {
  const reasons: string[] = [];
  // 2026-10-19 rename bridge: override rows written before the rename
  // hold legacy family slugs — canonicalize both sides so an active
  // override keeps matching its strategy through the rename.
  const match = (fam: string) => ovs.filter((o) => canonicalFamily(o.family) === canonicalFamily(fam));

  // family enable/disable (most specific family wins)
  for (const fam of ctx.families) {
    const en = match(fam).filter((o) => o.gate === "enable");
    if (en.length === 0) continue;
    const v = parseValue(en[0].value);
    if (v && v.enabled === false) return { allow: false, reasons: [`${fam} disabled by override`] };
    break;
  }

  const all = ctx.families.flatMap((f) => match(f));

  // hour veto: value { hours: number[] } — skip signals in those ET hours
  for (const o of all) {
    if (o.gate !== "hour_veto") continue;
    const v = parseValue(o.value);
    const hours = (v?.hours ?? v?.value) as number[] | number | undefined;
    const list = Array.isArray(hours) ? hours.map(Number) : hours !== undefined ? [Number(hours)] : [];
    if (list.includes(ctx.hourET)) {
      return { allow: false, reasons: [`hour veto ${ctx.hourET} ET (${o.family})`] };
    }
  }

  // trend filter: value { required: true, on: "cumDelta" } — direction must agree
  for (const o of all) {
    if (o.gate !== "trend_filter") continue;
    const v = parseValue(o.value);
    if (v?.required && ctx.cumDelta !== null) {
      const agrees = ctx.side === "long" ? ctx.cumDelta > 0 : ctx.cumDelta < 0;
      if (!agrees) return { allow: false, reasons: [`against session trend (trend_filter, ${o.family})`] };
    }
  }

  // side veto: value { side: "long" | "short", hours?: number[] } — skip
  // one side (optionally only inside given ET hours). The promotion-contract
  // gate for side-specific measured cells (ticketVeto side table,
  // sideFilterStudy). Fail-open: missing/invalid value never blocks.
  for (const o of all) {
    if (o.gate !== "side_veto") continue;
    const v = parseValue(o.value);
    const side = v?.side as string | undefined;
    const hours = (v?.hours ?? v?.value) as number[] | number | undefined;
    const list = Array.isArray(hours) ? hours.map(Number) : hours !== undefined ? [Number(hours)] : null;
    if (side === ctx.side && (list === null || list.includes(ctx.hourET))) {
      return { allow: false, reasons: [`${ctx.side} veto${list === null ? "" : ` in hour${list.length === 1 ? "" : "s"} ${list.join(",")} ET`} (${o.family})`] };
    }
  }

  // min count fraction: value { min: number, on: "count" } — the trigger
  // bar's aligned trade-count one-sidedness floor (countFracGateStudy,
  // 2026-10-16). Fail-open: null/unknown countFrac never blocks.
  for (const o of all) {
    if (o.gate !== "min_count_frac") continue;
    const v = parseValue(o.value);
    const min = numOf(v?.min);
    const on = v?.on;
    if (min !== null && on === "count" && ctx.countFrac !== null && ctx.countFrac !== undefined && ctx.countFrac < min) {
      return { allow: false, reasons: [`countFrac ${ctx.countFrac.toFixed(2)} < min ${min.toFixed(2)} (${o.family})`] };
    }
  }

  // min break fraction: value { min: number }
  for (const o of all) {
    if (o.gate !== "min_break_frac") continue;
    const v = parseValue(o.value);
    const min = numOf(v?.min);
    if (min !== null && ctx.breakFrac < min) {
      return { allow: false, reasons: [`breakFrac ${ctx.breakFrac.toFixed(2)} < min ${min.toFixed(2)}`] };
    }
  }

  // min break range (× ATR14): value { min: number }
  for (const o of all) {
    if (o.gate !== "min_break_range") continue;
    const v = parseValue(o.value);
    const min = numOf(v?.min);
    if (min !== null && ctx.breakRangeR !== null && ctx.breakRangeR < min) {
      return { allow: false, reasons: [`breakRangeR ${ctx.breakRangeR.toFixed(2)} < min ${min.toFixed(2)}`] };
    }
  }

  // max risk: value { maxRiskPts: number }
  for (const o of all) {
    if (o.gate !== "max_risk") continue;
    const v = parseValue(o.value);
    const max = numOf(v?.maxRiskPts);
    if (max !== null && ctx.riskPts > max) {
      return { allow: false, reasons: [`risk ${ctx.riskPts.toFixed(1)} > max ${max.toFixed(1)} pts`] };
    }
  }

  // first-of-day only: value { required: true }
  for (const o of all) {
    if (o.gate !== "first_only") continue;
    const v = parseValue(o.value);
    if (v?.required && !ctx.firstOfDay) {
      return { allow: false, reasons: ["rest-of-day card skipped (first_only)"] };
    }
  }

  return { allow: true, reasons };
}
