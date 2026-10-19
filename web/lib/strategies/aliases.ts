/* ------------------------------------------------------------------ *
 * Strategy family aliases — the 2026-10-19 rename bridge.
 *
 * Every strategy family got an expressive name; historical rows (Neon
 * tables, daybook JSONL, sweep payloads, R2 archive) keep the old
 * slugs forever. canonicalFamily() resolves BOTH directions to the
 * canonical slug, and familyMatchList() expands one family into the
 * list of slugs a persisted-value query must match (old + new).
 *
 * Group/plumbing families (momentum, open, all, other, momentum_bigbar,
 * pullback_ticket, unusual_volume, gap_alerts) are NOT strategies and
 * pass through unchanged.
 *
 * Ordering rule: legacy → canonical. Unknown values pass through.
 * ------------------------------------------------------------------ */

export const LEGACY_FAMILY_ALIAS: Record<string, string> = {
  momentum_flush: "failed_flush_breakout",
  momentum_expansion: "huge_bar_expansion",
  rth: "session_continuation",
  reversal: "lvn_reversal",
};

export const canonicalFamily = (fam: string): string => LEGACY_FAMILY_ALIAS[fam] ?? fam;

/** every slug a persisted family value may hold for this family:
 *  the canonical slug plus any legacy slugs that map to it. */
export function familyMatchList(fam: string): string[] {
  const canon = canonicalFamily(fam);
  const list = new Set<string>([canon]);
  for (const [legacy, target] of Object.entries(LEGACY_FAMILY_ALIAS)) {
    if (target === canon) list.add(legacy);
  }
  return [...list];
}
