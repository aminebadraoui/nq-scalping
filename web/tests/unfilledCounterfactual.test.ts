import { test } from "node:test";
import assert from "node:assert/strict";
import { unfilledCounterfactual, type CounterfactualSignal } from "../lib/unfilledCounterfactual";

const sig = (over: Partial<CounterfactualSignal> = {}): CounterfactualSignal => ({
  key: "s1",
  verdict: "momentum failed-flush breakout",
  side: "long",
  entry: "21000",
  stop: "20995",
  target: "21005",
  outcome: "win",
  ...over,
});

test("win/loss/time pts and wr exclude time", () => {
  const c = unfilledCounterfactual(
    [
      sig({ key: "a", outcome: "win" }), // +5
      sig({ key: "b", outcome: "win" }), // +5
      sig({ key: "c", outcome: "loss" }), // -5
      sig({ key: "d", outcome: "time" }), // 0, excluded from wr
    ],
    new Set(),
  );
  assert.equal(c.total, 4);
  assert.equal(c.decided, 4);
  assert.equal(c.wins, 2);
  assert.equal(c.losses, 1);
  assert.equal(c.times, 1);
  assert.equal(c.wr, 2 / 3);
  assert.equal(c.wouldBePts, 5);
});

test("filled signals are excluded from the counterfactual", () => {
  const c = unfilledCounterfactual(
    [sig({ key: "a" }), sig({ key: "b", outcome: "loss" })],
    new Set(["a"]),
  );
  assert.equal(c.total, 1);
  assert.equal(c.losses, 1);
  assert.equal(c.wouldBePts, -5);
});

test("unscored (open/blank) and unparseable geometry count as unscored", () => {
  const c = unfilledCounterfactual(
    [
      sig({ key: "a", outcome: "open" }),
      sig({ key: "b", outcome: "" }),
      sig({ key: "c", entry: "text", outcome: "win" }),
    ],
    new Set(),
  );
  assert.equal(c.total, 3);
  assert.equal(c.unscored, 3);
  assert.equal(c.decided, 0);
});

test("families aggregate with per-family wr and pts", () => {
  const c = unfilledCounterfactual(
    [
      sig({ key: "a", verdict: "rth soft-continuation (experimental)", outcome: "win" }),
      sig({ key: "b", verdict: "rth soft-continuation (experimental)", outcome: "loss" }),
      sig({ key: "c", verdict: "momentum (huge-bar expansion · retrace)", outcome: "loss" }),
    ],
    new Set(),
  );
  const rth = c.byFamily.find((f) => f.family === "session_continuation")!;
  assert.equal(rth.n, 2);
  assert.equal(rth.wr, 0.5);
  assert.equal(rth.wouldBePts, 0);
  const exp = c.byFamily.find((f) => f.family === "huge_bar_expansion")!;
  assert.equal(exp.losses, 1);
  assert.equal(exp.wouldBePts, -5);
});
