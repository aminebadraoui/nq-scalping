import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupFeature, driftKeys, FEATURE_REGISTRY } from "../lib/featureRegistry";
import { PRE_TRADE_KEYS, POST_HOC_KEYS } from "../lib/patternMining";

test("lookupFeature: exact keys resolve with role/type/doc", () => {
  const hit = lookupFeature("breakFrac");
  assert.equal(hit.registered, true);
  assert.equal(hit.entry?.role, "input");
  assert.equal(hit.entry?.type, "numeric");
  assert.equal(hit.entry?.group, "SIGNAL INPUTS");
  assert.ok(hit.entry?.doc);
});

test("lookupFeature: prefix families (dom.*, kelly.*) resolve", () => {
  for (const k of ["dom.nq.candidates", "dom.nq.nearStop", "dom.es.ts", "kelly.risk", "kelly.window", "kelly.priorWr"]) {
    assert.equal(lookupFeature(k).registered, true, k);
  }
  assert.equal(lookupFeature("dom.nq.nearStop").entry?.group, "DOM EVIDENCE");
  assert.equal(lookupFeature("kelly.risk").entry?.group, "KELLY");
});

test("lookupFeature: unknown keys are unregistered (the drift signal)", () => {
  assert.equal(lookupFeature("someNewFeature").registered, false);
  assert.equal(lookupFeature("").registered, false);
});

test("driftKeys returns only the unregistered keys", () => {
  assert.deepEqual(driftKeys(["breakFrac", "dom.nq.candidates", "mysteryKey", "kelly.f"]), ["mysteryKey"]);
  assert.deepEqual(driftKeys(["breakFrac"]), []);
});

test("every pre-trade and post-hoc key is registered (no silent drift)", () => {
  const unreg = driftKeys([...Object.keys(PRE_TRADE_KEYS), ...Object.keys(POST_HOC_KEYS)]);
  assert.deepEqual(unreg, []);
});

test("registry has no duplicate keys", () => {
  const exact = FEATURE_REGISTRY.filter((e) => !e.prefix).map((e) => e.key);
  assert.equal(new Set(exact).size, exact.length);
});
