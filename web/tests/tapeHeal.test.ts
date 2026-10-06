/* Unit tests for the tape-gap self-heal ladder (lib/live.ts
 * tapeHealDecision). The ladder recovers the vendor candle path — it never
 * changes the card gate itself, which keeps holding throughout. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedTapeHeal,
  tapeHealDecision,
  TAPE_HEAL_TAIL_ALERT,
  TAPE_HEAL_MAX_FORCED_FETCHES,
} from "../lib/live";

const T = 1_000_000_000;

test("no stall: no action and the state is untouched", () => {
  const h = seedTapeHeal();
  const r = tapeHealDecision(h, T, 2, 100);
  assert.equal(r.action, "none");
  assert.equal(r.next.sinceAt, 0);
});

test("a fresh boot with an all-tick buffer is a seed-in-flight, not a stall", () => {
  const h = seedTapeHeal();
  const r = tapeHealDecision(h, T, 100, 100);
  assert.equal(r.action, "none");
  assert.equal(r.next.sinceAt, 0);
});

test("stall start fires the first forced fetch immediately", () => {
  const h = seedTapeHeal();
  const r = tapeHealDecision(h, T, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(r.action, "force-fetch");
  assert.equal(r.next.sinceAt, T);
  assert.equal(r.next.step, 1);
  assert.equal(r.next.forcedFetches, 1);
});

test("second forced fetch one interval later, then no more fetches", () => {
  const h = { ...seedTapeHeal(), sinceAt: T, step: 1 as const, stepAt: T, forcedFetches: 1 };
  const early = tapeHealDecision(h, T + 5_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(early.action, "none");
  const onTime = tapeHealDecision(h, T + 60_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(onTime.action, "force-fetch");
  assert.equal(onTime.next.forcedFetches, TAPE_HEAL_MAX_FORCED_FETCHES);
});

test("after two failed fetches the ladder forces a reconnect at 120s", () => {
  const h = { ...seedTapeHeal(), sinceAt: T, step: 1 as const, stepAt: T + 60_000, forcedFetches: 2 };
  const before = tapeHealDecision(h, T + 119_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(before.action, "none");
  const at = tapeHealDecision(h, T + 120_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(at.action, "force-reconnect");
  assert.equal(at.next.step, 2);
  assert.equal(at.next.reconnects, 1);
});

test("after the reconnect the ladder re-seeds the buffer once at 300s", () => {
  const h = { ...seedTapeHeal(), sinceAt: T, step: 2 as const, stepAt: T + 120_000, forcedFetches: 2, reconnects: 1 };
  const before = tapeHealDecision(h, T + 299_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(before.action, "none");
  const at = tapeHealDecision(h, T + 300_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(at.action, "force-reseed");
  assert.equal(at.next.step, 3);
  assert.equal(at.next.reseeds, 1);
  const again = tapeHealDecision(at.next, T + 400_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(again.action, "none");
});

test("a clearing tail closes the episode and resets the ladder", () => {
  const h = { ...seedTapeHeal(), sinceAt: T, step: 2 as const, stepAt: T + 120_000, forcedFetches: 2, reconnects: 1, episodes: 3 };
  const r = tapeHealDecision(h, T + 600_000, 1, 100);
  assert.equal(r.action, "none");
  assert.equal(r.next.sinceAt, 0);
  assert.equal(r.next.forcedFetches, 0);
  assert.equal(r.next.reconnects, 0);
  assert.equal(r.next.reseeds, 0);
  assert.equal(r.next.healedAt, T + 600_000);
  assert.equal(r.next.episodes, 4);
});

test("the next stall after a heal restarts the ladder from step 1", () => {
  const h = { ...seedTapeHeal(), healedAt: T, episodes: 1 };
  const r = tapeHealDecision(h, T + 3_600_000, TAPE_HEAL_TAIL_ALERT, 100);
  assert.equal(r.action, "force-fetch");
  assert.equal(r.next.forcedFetches, 1);
  assert.equal(r.next.sinceAt, T + 3_600_000);
});
