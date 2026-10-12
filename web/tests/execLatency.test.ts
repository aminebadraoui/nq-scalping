/* Unit tests for the execution-latency telemetry (lib/execLatency.ts):
 * cycle lifecycle, the fire-and-forget grace window, fill-leg matching,
 * and the pure aggregates. Timing marks must never throw or change
 * control flow — that is the whole contract of the instrumentation. */
import { test } from "node:test";
import assert from "node:assert";
import {
  startCycle,
  markStage,
  markCheck,
  markDispatch,
  markBarAge,
  finishCycle,
  noteOrderSubmit,
  noteOrderAck,
  noteOrderFill,
  latencySnapshot,
  pct,
  stageAggregates,
  __resetExecLatencyForTest,
  type CycleRecord,
} from "../lib/execLatency";

test("cycle: stages accumulate and the finish record carries them", () => {
  __resetExecLatencyForTest();
  startCycle();
  markStage("getData", 10);
  markStage("getData", 5);
  markCheck("momentum", 2.5);
  markDispatch(120, 7_200);
  finishCycle("ok");
  const snap = latencySnapshot();
  assert.ok(snap.latest);
  assert.equal(snap.latest.stages.getData, 15);
  assert.equal(snap.latest.stages.compute, 2.5);
  assert.equal(snap.latest.stages.dispatch, 120);
  assert.equal(snap.latest.detail.detectLagMs, 7200);
  assert.equal(snap.latest.detail.note, "ok");
  assert.equal(snap.latest.detail.checks?.[0].name, "momentum");
  assert.ok(snap.latest.totalMs >= 0);
  assert.equal(snap.window.length, 1);
  assert.equal(snap.current, null);
});

test("grace window: a late dispatch mark lands on the just-finished cycle", () => {
  __resetExecLatencyForTest();
  startCycle();
  finishCycle();
  markDispatch(300, 12_000); // fire-and-forget promise settling after finish
  const snap = latencySnapshot();
  assert.equal(snap.latest?.stages.dispatch, 300);
  assert.equal(snap.latest?.detail.detectLagMs, 12000);
  assert.equal(snap.current, null);
});

test("bar age: stamped per cycle, survives the grace window, rounded", () => {
  __resetExecLatencyForTest();
  startCycle();
  markBarAge(7_234.6);
  finishCycle();
  assert.equal(latencySnapshot().latest?.detail.barAgeMs, 7235);
  // grace-window stamp lands on the finished record too
  startCycle();
  finishCycle();
  markBarAge(1_500);
  assert.equal(latencySnapshot().latest?.detail.barAgeMs, 1500);
});

test("marks outside any cycle are no-ops, never throws", () => {
  __resetExecLatencyForTest();
  markStage("getData", 1);
  markCheck("x", 1);
  markDispatch(1, 1);
  finishCycle();
  assert.equal(latencySnapshot().latest, null);
});

test("window caps at the ring size", () => {
  __resetExecLatencyForTest();
  for (let i = 0; i < 130; i++) {
    startCycle();
    markStage("getData", i);
    finishCycle();
  }
  const snap = latencySnapshot();
  assert.ok(snap.window.length <= 120);
  assert.equal(snap.latest?.stages.getData, 129); // newest first
});

test("fill leg: submit → ack → fill closes with the broker fill timestamp", () => {
  __resetExecLatencyForTest();
  const id = noteOrderSubmit("momentum long 14:03", "long", 4);
  assert.ok(id);
  noteOrderAck(id, 210, 210);
  let snap = latencySnapshot();
  assert.equal(snap.lastFills[0]?.detail.submitMs, 210);
  assert.equal(snap.lastFills[0]?.detail.ackMs, 210);
  assert.equal(snap.lastFills[0]?.detail.fillMs, null);

  const submitAt = snap.lastFills[0]!.ts;
  const fillTs = submitAt + 1_800; // filled 1.8s after the POST
  noteOrderFill("long", 4, fillTs);
  snap = latencySnapshot();
  assert.equal(snap.lastFills[0]?.detail.fillMs, 1800);
  assert.equal(snap.lastFills[0]?.totalMs, 1800);
  assert.ok((snap.lastFills[0]?.detail.seenMs ?? 0) >= 0);
});

test("fill matching: wrong side/qty or too-old fill never closes a leg", () => {
  __resetExecLatencyForTest();
  const id = noteOrderSubmit("rth short 10:12", "short", 3);
  assert.ok(id);
  const submitAt = latencySnapshot().lastFills[0]!.ts;
  noteOrderFill("long", 3, submitAt + 500); // wrong side
  assert.equal(latencySnapshot().lastFills[0]?.detail.fillMs, null);
  noteOrderFill("short", 9, submitAt + 500); // wrong qty
  assert.equal(latencySnapshot().lastFills[0]?.detail.fillMs, null);
  noteOrderFill("short", 3, submitAt + 11 * 60_000); // outside the match window
  assert.equal(latencySnapshot().lastFills[0]?.detail.fillMs, null);
  noteOrderFill("short", 3, submitAt + 2_000);
  assert.equal(latencySnapshot().lastFills[0]?.detail.fillMs, 2000);
});

test("pct: nearest-rank percentiles", () => {
  assert.equal(pct([], 50), null);
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(pct(xs, 50), 50);
  assert.equal(pct(xs, 95), 95);
  assert.equal(pct([7], 95), 7);
});

test("stageAggregates: p50/p95/n per stage over cycles", () => {
  const mk = (getData: number, feedCheck: number, compute: number, dispatch: number): CycleRecord => ({
    id: "x",
    ts: Date.now(),
    kind: "cycle",
    totalMs: 0,
    stages: { getData, feedCheck, compute, dispatch },
    detail: {},
  });
  const agg = stageAggregates([mk(10, 1, 4, 100), mk(20, 2, 8, 200), mk(30, 3, 12, 300)]);
  assert.equal(agg.getData?.n, 3);
  assert.equal(agg.getData?.p50, 20);
  assert.equal(agg.getData?.p95, 30);
  assert.equal(agg.feedCheck?.p95, 3);
  assert.equal(agg.dispatch?.p50, 200);
});
