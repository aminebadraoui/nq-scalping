/* Unit tests for the tick-momentum engine (lib/tickMomentum.ts).
 *
 * Synthetic tapes pin the decode: a one-sided tape must read fully
 * asymmetric, a symmetric sawtooth must read balanced, a V-shaped dip
 * must produce a probe whose recovery time/speed are exact, and window
 * trimming must drop stale history. */
import { test } from "node:test";
import assert from "node:assert";
import { computeTickMomentum, type Tick } from "../lib/tickMomentum";

const T0 = Date.parse("2026-10-03T13:30:00Z");

/** tape builder: ms steps of `stepMs` from T0, price deltas in points,
 *  size per tick, side per tick */
function tape(
  steps: number[], // price points per tick
  opts: { stepMs?: number; size?: number | number[]; side?: (1 | -1) | (1 | -1)[]; base?: number } = {},
): Tick[] {
  const { stepMs = 100, size = 1, side = 1, base = 30_800 } = opts;
  let ms = T0;
  let p = base;
  const out: Tick[] = [{ ms, ltp: p, size: Array.isArray(size) ? size[0] : size, side: Array.isArray(side) ? side[0] : side }];
  for (let i = 0; i < steps.length; i++) {
    ms += stepMs;
    p += steps[i];
    out.push({
      ms,
      ltp: p,
      size: Array.isArray(size) ? size[i + 1] ?? 1 : size,
      side: Array.isArray(side) ? side[i + 1] ?? 1 : side,
    });
  }
  return out;
}

test("one-sided up-tape reads fully asymmetric", () => {
  const m = computeTickMomentum(tape([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]));
  assert.equal(m.n, 10);
  assert.ok(Math.abs(m.upPts - 2.25) < 1e-9);
  assert.equal(m.downPts, 0);
  assert.equal(m.velImb, 1);
  assert.ok(Math.abs(m.netVel - 2.5) < 1e-9); // 2.25 pts / 0.9s
  assert.equal(m.upTicks, 9);
  assert.equal(m.downTicks, 0);
  assert.equal(m.upLegs, 1);
  assert.ok(Math.abs(m.meanUpLeg - 2.25) < 1e-9);
  assert.equal(m.verdict, "pushing up");
});

test("one-sided down-tape mirrors", () => {
  const m = computeTickMomentum(tape([-0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25, -0.25], { side: -1 }));
  assert.equal(m.velImb, -1);
  assert.ok(Math.abs(m.netVel + 2.5) < 1e-9);
  assert.equal(m.verdict, "pushing down");
});

test("symmetric sawtooth reads balanced with churn energy", () => {
  const steps: number[] = [];
  for (let i = 0; i < 20; i++) steps.push(i % 2 === 0 ? 0.25 : -0.25);
  const m = computeTickMomentum(tape(steps));
  assert.ok(Math.abs(m.velImb) < 1e-9);
  assert.equal(m.upLegs, 10);
  assert.equal(m.downLegs, 10);
  // energy = (2.5 + 2.5) pts / 2s = 2.5 pt/s >= churn floor → two-sided
  assert.equal(m.verdict, "two-sided");
});

test("flat tape: no moves, quiet verdict", () => {
  const m = computeTickMomentum(tape([0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(m.upPts + m.downPts, 0);
  assert.equal(m.velImb, 0);
  assert.equal(m.flatTicks, 9);
  assert.equal(m.verdict, "quiet");
});

test("V-shaped dip produces an exact answered probe", () => {
  // rise to a local high, dip 1.0 pt (4 ticks), retrace 0.5 pt quickly
  const steps = [0.25, 0.25, 0.25, 0.25, -0.25, -0.25, -0.25, -0.25, 0.25, 0.25];
  const m = computeTickMomentum(tape(steps));
  const down = m.probes.filter((p) => p.dir === "down");
  assert.equal(down.length, 1);
  const p = down[0];
  assert.equal(p.answered, true);
  assert.ok(Math.abs(p.depth - 1.0) < 1e-9);
  // 50% retrace of the 1.0pt dip is price 30800.5 — the tick at T0+1000ms;
  // the deepest point printed at T0+800ms, so the answer took 200ms
  assert.equal(p.recoveryMs, 200);
  assert.ok(Math.abs(p.retrace - 0.5) < 1e-9);
  assert.ok(Math.abs(p.speed - 5) < 1e-9); // 1 pt / 0.2 s
  // the rally itself was also a probe (mirror): answered at 200ms too
  const up = m.probes.filter((x) => x.dir === "up");
  assert.equal(up.length, 1);
  assert.equal(up[0].recoveryMs, 200);
  assert.equal(m.medianRecoveryMs, 200);
  assert.ok(Math.abs(m.rejectSpeed - 5) < 1e-9);
});

test("probes below the minimum depth are ignored", () => {
  // 2-tick dip (0.5 pt) then recovery — under probeMinTicks = 3
  const steps = [0.5, -0.25, -0.25, 0.5];
  const m = computeTickMomentum(tape(steps));
  assert.equal(m.probes.length, 0);
});

test("an unanswered dip stays open", () => {
  const steps = [0.5, -0.25, -0.25, -0.25];
  const m = computeTickMomentum(tape(steps));
  const down = m.probes.filter((p) => p.dir === "down");
  assert.equal(down.length, 1);
  assert.equal(down[0].answered, false);
  assert.equal(down[0].recoveryMs, 0);
  assert.equal(down[0].speed, 0);
  assert.equal(m.medianRecoveryMs, 0);
});

test("a feed gap aborts the in-flight probe", () => {
  // the dip reaches probe depth BEFORE the gap; the gap (3s) exceeds
  // staleGapMs (2s) but stays inside the 5s analysis window
  const steps = [0.5, -0.25, -0.25, -0.25, -0.25];
  const stepMs = [100, 100, 100, 100, 3_000, 100]; // > staleGapMs after the dip
  let ms = T0;
  let p = 30_800;
  const ticks: Tick[] = [{ ms, ltp: p, size: 1, side: 1 }];
  for (let i = 0; i < steps.length; i++) {
    ms += stepMs[i];
    p += steps[i];
    ticks.push({ ms, ltp: p, size: 1, side: 1 });
  }
  const m = computeTickMomentum(ticks);
  const down = m.probes.filter((x) => x.dir === "down");
  assert.equal(down.length, 1);
  assert.equal(down[0].answered, false);
});

test("window trim: stale history excluded from velocity and probes", () => {
  // old sawtooth 30 s ago, then a fresh one-sided up-tape
  const oldTicks = tape([-0.25, 0.25, -0.25, 0.25, -0.25], { stepMs: 100 });
  const fresh = tape([0.25, 0.25], { stepMs: 100 });
  const shift = 30_000;
  const merged = [...oldTicks, ...fresh.map((t) => ({ ...t, ms: t.ms + shift }))];
  const m = computeTickMomentum(merged);
  assert.equal(m.n, 3);
  assert.equal(m.velImb, 1);
  assert.equal(m.probes.length, 0); // stale probes are outside both windows
});

test("price-impact ratio credits each tick's move to its aggressor side", () => {
  // buys move +0.5, sells move −0.25, alternating — one contract each;
  // the first tick is a buy that moved nothing, so it dilutes λ_up only
  const steps: number[] = [];
  const side: (1 | -1)[] = [1];
  for (let i = 0; i < 10; i++) {
    steps.push(0.5);
    side.push(1);
    steps.push(-0.25);
    side.push(-1);
  }
  const m = computeTickMomentum(tape(steps, { side }));
  assert.ok(Math.abs(m.impactUp - 5 / 11) < 1e-9); // 5 pts / 11 buy contracts
  assert.ok(Math.abs(m.impactDown - 0.25) < 1e-9); // 2.5 pts / 10 sell contracts
  assert.ok(Math.abs(m.impactRatio - 20 / 11) < 1e-9);
  assert.ok(Math.abs(m.arrImb - 1 / 21) < 1e-9); // 11 buys vs 10 sells
  assert.ok(Math.abs(m.velImb - 1 / 3) < 1e-9); // 5 up vs 2.5 down
  // leg asymmetry: up-legs are 2× the down-legs
  assert.ok(Math.abs(m.legImb - 1 / 3) < 1e-9);
});

test("unsorted input is ordered by wall clock", () => {
  const t = tape([0.25, 0.25, 0.25]);
  const reversed = [...t].reverse();
  const a = computeTickMomentum(t);
  const b = computeTickMomentum(reversed);
  assert.equal(a.velImb, b.velImb);
  assert.equal(a.n, b.n);
});

test("empty and garbage input return the quiet default", () => {
  for (const bad of [[], [{ ms: NaN, ltp: 1, size: 1, side: 1 as const }], [{ ms: 1, ltp: 30_800, size: 0, side: 1 as const }]] as Tick[][]) {
    const m = computeTickMomentum(bad);
    assert.equal(m.n, 0);
    assert.equal(m.verdict, "quiet");
    assert.equal(m.probes.length, 0);
  }
});

test("too few ticks in the window stay quiet", () => {
  const m = computeTickMomentum(tape([0.25]));
  assert.equal(m.n, 2); // below minWindowTicks (3)
  assert.equal(m.verdict, "quiet");
  assert.equal(m.netVel, 0);
});
