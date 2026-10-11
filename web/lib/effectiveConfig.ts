/* ------------------------------------------------------------------ *
 * Effective config — the ONE resolver for "what exactly is running".
 *
 * Architecture review 2026-10-11 P2 (docs/architecture/ARCHITECTURE-REVIEW.md):
 * live configuration previously lived in four stacked registers (code
 * constants, Coolify env, strategy_overrides DB rows, exec-overrides.json)
 * with no single artifact answering "what is in effect right now?".
 * This module assembles that answer from one place:
 *
 *   declaration defaults (lib/strategies/registry.ts)
 *     → env overrides (FEED_* flags, guard knobs via guardCore)
 *     → strategy_overrides rows (passed in by the caller — no I/O here)
 *     → operator exec-overrides (passed in by the caller)
 *
 * Pure assembly only: no fs, no network, no env reads of its own — the
 * callers (API routes, daybook snapshots) supply the inputs, so the
 * snapshot is testable and deterministic. The daybook variation remains
 * the frozen record; this is the READABLE rendering of it.
 * ------------------------------------------------------------------ */

import { STRATEGIES, type StrategyDeclaration } from "./strategies/registry";
import { guardConfigFromEnv, type GuardConfig } from "./risk/guardCore";
import type { Override } from "./strategyOverrides";

/** feed-flag resolution — the same semantics as signalFeed's feedFlag():
 *  "1/true/yes/on" enables, "0/false/no/off" disables, unset = default. */
export function resolveFeedFlag(name: string, def: boolean, env: Record<string, string | undefined>): boolean {
  const v = env[name];
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v);
}

export type StrategyConfigView = {
  id: StrategyDeclaration["id"];
  family: string;
  status: StrategyDeclaration["status"];
  feedFlag: string;
  feedDefault: boolean;
  feedEnabled: boolean;
};

export type EffectiveConfig = {
  frozenAt: number;
  strategies: StrategyConfigView[];
  guard: GuardConfig;
  /** active strategy_overrides rows (family.gate → value) */
  overrides: { family: string; gate: string; value: unknown }[];
  /** masked operator overrides (exec-overrides.json), keys only */
  operator: string[];
};

/**
 * Assemble the effective configuration snapshot. `overrides` = active
 * strategy_overrides rows (strategyOverrides.getOverrides()); `operator` =
 * the masked keys present in exec-overrides.json. Both are supplied by
 * the caller so this function stays pure.
 */
export function effectiveConfigSnapshot(
  env: Record<string, string | undefined> = process.env,
  overrides: Override[] = [],
  operator: string[] = [],
  frozenAt: number = Date.now(),
): EffectiveConfig {
  const strategies: StrategyConfigView[] = STRATEGIES.map((s) => ({
    id: s.id,
    family: s.family,
    status: s.status,
    feedFlag: s.feedFlag,
    feedDefault: s.feedDefault,
    feedEnabled: s.feedFlag ? resolveFeedFlag(s.feedFlag, s.feedDefault, env) : false,
  }));
  return {
    frozenAt,
    strategies,
    guard: guardConfigFromEnv(env),
    overrides: overrides.map((o) => ({ family: o.family, gate: o.gate, value: o.value })),
    operator,
  };
}
