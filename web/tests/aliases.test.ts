/* 2026-10-19 rename bridge — the alias layer must resolve legacy family
 * slugs forever (historical Neon rows, daybook JSONL, sweep payloads,
 * R2 archive), and familyMatchList must expand to old + new for
 * persisted-value queries. */

import { test } from "node:test";
import assert from "node:assert";
import { canonicalFamily, familyMatchList, LEGACY_FAMILY_ALIAS } from "../lib/strategies/aliases";

test("canonicalFamily maps every legacy slug to its new name", () => {
  assert.equal(canonicalFamily("momentum_flush"), "failed_flush_breakout");
  assert.equal(canonicalFamily("momentum_expansion"), "huge_bar_expansion");
  assert.equal(canonicalFamily("rth"), "session_continuation");
  assert.equal(canonicalFamily("reversal"), "lvn_reversal");
});

test("canonicalFamily is idempotent for canonical + plumbing slugs", () => {
  for (const v of ["failed_flush_breakout", "huge_bar_expansion", "session_continuation", "lvn_reversal"]) {
    assert.equal(canonicalFamily(v), v);
  }
  for (const v of ["momentum", "open", "all", "other", "momentum_bigbar", "pullback_ticket", "unusual_volume", "gap_alerts", ""]) {
    assert.equal(canonicalFamily(v), v);
  }
});

test("familyMatchList includes canonical + legacy slugs", () => {
  assert.deepEqual(familyMatchList("momentum_flush").sort(), ["failed_flush_breakout", "momentum_flush"]);
  assert.deepEqual(familyMatchList("session_continuation").sort(), ["rth", "session_continuation"]);
  // plumbing family: only itself
  assert.deepEqual(familyMatchList("momentum"), ["momentum"]);
});

test("the alias table stays a bijection of unique legacy keys", () => {
  const keys = Object.keys(LEGACY_FAMILY_ALIAS);
  assert.equal(new Set(keys).size, keys.length, "legacy keys must be unique");
});
