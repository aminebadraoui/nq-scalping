import { test } from "node:test";
import assert from "node:assert/strict";
import { groupKeyOf, groupFeatures, GROUP_ORDER } from "../lib/featureGroups";

test("signal-input keys classify into the signal group", () => {
  for (const k of ["flushFrac", "breakRangeR", "cumDelta", "riskPts", "deltaFrac", "domClusters", "breakFrac", "atr14"]) {
    assert.equal(groupKeyOf(k), "signal", k);
  }
});

test("label/gate keys classify into the labels group", () => {
  for (const k of ["aPlus", "firstToday", "family", "gates", "rejectedBy", "newsBlocked", "retrace"]) {
    assert.equal(groupKeyOf(k), "labels", k);
  }
});

test("study-only prefix families classify into their groups", () => {
  assert.equal(groupKeyOf("esBroadConfirm"), "es");
  assert.equal(groupKeyOf("seasonalFomcDay"), "seasonal");
  assert.equal(groupKeyOf("entryToRound50"), "round");
  assert.equal(groupKeyOf("gapInPath"), "gaps");
  assert.equal(groupKeyOf("wallInPath"), "walls");
  assert.equal(groupKeyOf("kelly.risk"), "kelly");
  assert.equal(groupKeyOf("dom.nq.candidates"), "dom");
});

test("unknown keys fall back to other", () => {
  assert.equal(groupKeyOf("somethingNew"), "other");
});

test("groupFeatures buckets, sorts, omits empty groups, and skips nulls", () => {
  const flat = {
    breakFrac: 0.8,
    flushFrac: 0.2,
    aPlus: true,
    dom: { nq: { ts: 123 } }, // stays a nested leaf (flattening is the caller's job)
    wallAhead: "call",
    zzUnknown: 7,
    skippedNull: null,
    skippedUndefined: undefined,
  };
  const groups = groupFeatures(flat);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["signal", "labels", "walls", "dom", "other"],
    "groups follow GROUP_ORDER and skip empty ones",
  );
  const signal = groups.find((g) => g.key === "signal")!;
  assert.deepEqual(
    signal.entries.map(([k]) => k),
    ["breakFrac", "flushFrac"],
    "entries sorted by path",
  );
  assert.equal(signal.role, "signal");
  const other = groups.find((g) => g.key === "other")!;
  assert.equal(other.role, "study");
  assert.deepEqual(other.entries, [["zzUnknown", 7]]);
});

test("groupFeatures: null input yields no groups", () => {
  assert.deepEqual(groupFeatures(null), []);
  assert.deepEqual(groupFeatures(undefined), []);
  assert.deepEqual(groupFeatures({}), []);
});

test("every declared group appears in the ordering and roles are consistent", () => {
  assert.equal(GROUP_ORDER.length, 10);
  assert.equal(GROUP_ORDER[0].key, "signal", "signal inputs lead");
  assert.equal(GROUP_ORDER[0].role, "signal");
  assert.equal(GROUP_ORDER[1].key, "labels");
  assert.equal(GROUP_ORDER[1].role, "signal", "vetoes/labels did decide");
  for (const g of GROUP_ORDER.slice(2)) assert.equal(g.role, "study", g.key);
});
