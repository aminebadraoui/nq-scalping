/* Signal composer regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSignals, cardGateOpen } from "../lib/signals.ts";

const box = (id, side, score = side ? 0.7 : 0) => ({
  id,
  name: id,
  side,
  tone: side === null ? "neutral" : side,
  score,
  verdict: `${id}:${side ?? "neutral"}`,
});

test("all boxes agreeing long → ALIGNED LONG", () => {
  const s = composeSignals([box("orderflow", "long"), box("priceaction", "long")]);
  assert.equal(s.side, "long");
  assert.equal(s.tone, "long");
  assert.equal(s.agree, true);
  assert.match(s.verdict, /ALIGNED LONG/);
});

test("one long, one neutral → long but not yet aligned", () => {
  const s = composeSignals([box("orderflow", "long"), box("priceaction", null)]);
  assert.equal(s.side, "long");
  assert.equal(s.tone, "forming");
  assert.equal(s.agree, false);
  assert.match(s.verdict, /LONG/);
});

test("long vs short → conflict, no trade", () => {
  const s = composeSignals([box("orderflow", "long"), box("priceaction", "short")]);
  assert.equal(s.side, null);
  assert.equal(s.tone, "neutral");
  assert.match(s.verdict, /CONFLICT/);
});

test("no directional boxes → NO SIGNAL", () => {
  const s = composeSignals([box("orderflow", null), box("priceaction", null)]);
  assert.equal(s.side, null);
  assert.match(s.verdict, /NO SIGNAL/);
});

test("three boxes: two long, one short is still a conflict", () => {
  const s = composeSignals([box("a", "long"), box("b", "long"), box("c", "short")]);
  assert.equal(s.side, null);
  assert.match(s.verdict, /CONFLICT/);
});

/* ---- the card gate (STRATEGY.md "When a signal exists") ---- */

const ing = (key, role, state) => ({ key, n: key.charAt(0), name: key, role, state, short: "", value: "", why: "" });

/** a MechanismRead fixture: required pieces default to "yes", supports "no" */
const mechRead = (over = {}) => {
  const states = {
    location: "yes",
    mechanism: "yes",
    trigger: "yes",
    fuel: "no",
    evidence: "no",
    context: "no",
    ...over,
  };
  const ingredients = [
    ing("location", "required", states.location),
    ing("mechanism", "required", states.mechanism),
    ing("trigger", "required", states.trigger),
    ing("fuel", "support", states.fuel),
    ing("evidence", "support", states.evidence),
    ing("context", "filter", states.context),
  ];
  return {
    side: "long",
    tone: "long",
    verdict: "v",
    headline: "h",
    narrative: "",
    ingredients,
    present: ingredients.filter((i) => i.state === "yes").length,
    missing: [],
    trigger: "",
    invalidation: "",
    target: "",
    asOf: "",
    live: false,
    entryPx: 100,
    stopPx: 93,
    targetPx: 110,
    lastDelta: 5,
  };
};

const alignedLong = () => composeSignals([box("orderflow", "long"), box("priceaction", "long")]);

test("gate open: boxes aligned, all 3 required, 4/6 present", () => {
  const g = cardGateOpen(alignedLong(), mechRead({ fuel: "yes" }));
  assert.equal(g.ok, true);
});

test("gate closed: no reclaim — the trigger is missing, so no trade", () => {
  const g = cardGateOpen(alignedLong(), mechRead({ trigger: "no", fuel: "yes", evidence: "yes" }));
  assert.equal(g.ok, false);
  assert.match(g.reason, /trigger/);
});

test("gate closed: location only partial (gamma wall / extreme) is not an LVN", () => {
  const g = cardGateOpen(alignedLong(), mechRead({ location: "partial", fuel: "yes" }));
  assert.equal(g.ok, false);
  assert.match(g.reason, /location/);
});

test("gate closed: 3/6 present is below the 4/6 card gate", () => {
  const g = cardGateOpen(alignedLong(), mechRead({}));
  assert.equal(g.ok, false);
  assert.match(g.reason, /4\/6/);
});

test("gate closed: boxes not aligned — a neutral box means no push", () => {
  const sig = composeSignals([box("orderflow", "long"), box("priceaction", null)]);
  const g = cardGateOpen(sig, mechRead({ fuel: "yes" }));
  assert.equal(g.ok, false);
  assert.match(g.reason, /not aligned/);
});
