/* Signal composer regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSignals } from "../lib/signals.ts";

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
