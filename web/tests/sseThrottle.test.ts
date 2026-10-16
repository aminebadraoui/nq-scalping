/* Unit tests for lib/sseThrottle.ts — trailing-edge emission throttle
 * (2026-10-16: the per-tick full-state SSE serialize saturated the
 * server during RTH). */

import { test } from "node:test";
import assert from "node:assert";
import { sseThrottle } from "../lib/sseThrottle";

test("sseThrottle passes the first event through immediately", () => {
  const sent: unknown[] = [];
  const t = sseThrottle((d) => sent.push(d), { gapMs: 1000, now: () => 0 });
  t({ a: 1 });
  assert.equal(sent.length, 1);
});

test("sseThrottle coalesces bursts into the LATEST state, one flush per gap", () => {
  let clock = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const sent: unknown[] = [];
  const t = sseThrottle((d) => sent.push(d), {
    gapMs: 1000,
    now: () => clock,
    setTimeoutFn: (fn: () => void, ms?: number) => {
      timers.push({ fn, ms: ms ?? 0 });
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {},
  });
  t({ n: 1 }); // passes (first)
  clock = 100;
  t({ n: 2 }); // throttled
  clock = 200;
  t({ n: 3 }); // throttled — replaces n:2
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1);
  timers[0].fn(); // gap elapsed
  assert.deepEqual(sent, [{ n: 1 }, { n: 3 }]); // only the latest flushed
});

test("sseThrottle lets events through again after the gap", () => {
  let clock = 0;
  const sent: unknown[] = [];
  const t = sseThrottle((d) => sent.push(d), { gapMs: 1000, now: () => clock });
  t({ n: 1 });
  clock = 500;
  t({ n: 2 }); // throttled (pending)
  clock = 1500; // past the gap
  t({ n: 3 }); // passes directly, pending n:2 still queued
  assert.equal(sent.length, 2); // n:1, n:3 (the pending flush is timer-driven)
  assert.deepEqual(sent[1], { n: 3 });
});

test("sseThrottle flush() delivers the pending latest immediately", () => {
  let clock = 0;
  const sent: unknown[] = [];
  const t = sseThrottle((d) => sent.push(d), {
    gapMs: 1000,
    now: () => clock,
    setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimeoutFn: () => {},
  });
  t({ n: 1 });
  clock = 100;
  t({ n: 2 });
  t.flush();
  assert.deepEqual(sent, [{ n: 1 }, { n: 2 }]);
});

test("sseThrottle with zero gap never coalesces", () => {
  const sent: unknown[] = [];
  const t = sseThrottle((d) => sent.push(d), { gapMs: 0, now: () => 1000 });
  t({ a: 1 });
  t({ a: 2 });
  assert.equal(sent.length, 2);
});
