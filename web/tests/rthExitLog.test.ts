/* Unit tests for the RTH winner-exit log (lib/rthExitLog.ts) — the live
 * side of the counter-signal gate. Pure ring-buffer + decision helpers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  noteRthExit,
  recentRthExits,
  counterGateDecision,
  counterGateParams,
  __resetRthExitLogForTest,
} from "../lib/rthExitLog";

test("counterGateDecision: disabled knobs never block", () => {
  const exits = [{ dir: "short" as const, exitPrice: 31339, exitAt: 100 }];
  assert.deepEqual(counterGateDecision("long", 31339, 200_000, 0, 5, exits), { block: false, winner: null });
  assert.deepEqual(counterGateDecision("long", 31339, 200_000, 15 * 60_000, 0, exits), { block: false, winner: null });
});

test("counterGateDecision: opposite-side winner within distance blocks", () => {
  const exits = [{ dir: "short" as const, exitPrice: 31339, exitAt: 100 }];
  const r = counterGateDecision("long", 31339.5, 200_000, 15 * 60_000, 5, exits);
  assert.equal(r.block, true);
  assert.equal(r.winner?.exitPrice, 31339);
});

test("counterGateDecision: same side or far price does not block", () => {
  const exits = [
    { dir: "short" as const, exitPrice: 31339, exitAt: 100 },
    { dir: "long" as const, exitPrice: 31330, exitAt: 120 },
  ];
  assert.equal(counterGateDecision("short", 31339, 200_000, 15 * 60_000, 5, exits).block, false); // same side
  assert.equal(counterGateDecision("long", 31360, 200_000, 15 * 60_000, 5, exits).block, false); // too far
});

test("recentRthExits: time window + pruning", () => {
  __resetRthExitLogForTest();
  noteRthExit("short", 31339, 1_000);
  noteRthExit("short", 31320, 500_000);
  const recent = recentRthExits(500_000 + 5 * 60_000, 10 * 60_000);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].exitPrice, 31320);
});

test("counterGateParams parses the env knobs", () => {
  assert.deepEqual(counterGateParams({}), { enabled: false, minMs: 0, pts: 0 });
  assert.deepEqual(counterGateParams({ RTH_COUNTER_GATE_MIN: "15", RTH_COUNTER_GATE_PTS: "5" }), {
    enabled: true,
    minMs: 900_000,
    pts: 5,
  });
  assert.equal(counterGateParams({ RTH_COUNTER_GATE_MIN: "x", RTH_COUNTER_GATE_PTS: "5" }).enabled, false);
});
