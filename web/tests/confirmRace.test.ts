/* Unit tests for the confirmation-race pure helpers (lib/live.ts) — the
 * race itself is a live-only mechanism; the env gating and the outcome
 * formatter are what the logs, health, and operator read. */
import { test } from "node:test";
import assert from "node:assert";
import { formatConfirmRace, fastDispatchEnabled, confirmRaceEnabled, loadEnv } from "../lib/live";

test("formatConfirmRace: REST wins when it confirms first", () => {
  const close = Date.UTC(2026, 9, 11, 2, 23, 0);
  const line = formatConfirmRace("2026-10-11|02:22", close, close + 2_100, close + 7_600, close + 12_000);
  assert.match(line, /REST\+2\.1s/);
  assert.match(line, /frame\+7\.6s/);
  assert.match(line, /→ REST wins/);
});

test("formatConfirmRace: frame wins when REST is slower", () => {
  const close = Date.UTC(2026, 9, 11, 2, 23, 0);
  const line = formatConfirmRace("2026-10-11|02:22", close, close + 9_000, close + 7_500, close + 12_000);
  assert.match(line, /→ frame wins/);
});

test("formatConfirmRace: REST-only confirmation (no frame observed)", () => {
  const close = Date.UTC(2026, 9, 11, 2, 23, 0);
  const line = formatConfirmRace("2026-10-11|02:22", close, close + 3_000, 0, close + 12_000);
  assert.match(line, /frame —/);
  assert.match(line, /→ REST wins/);
});

test("formatConfirmRace: neither channel confirmed inside the window", () => {
  const close = Date.UTC(2026, 9, 11, 2, 23, 0);
  const line = formatConfirmRace("2026-10-11|02:22", close, 0, 0, close + 12_000);
  assert.match(line, /NEITHER confirmed/);
  assert.match(line, /12\.0s since close/);
});

test("fastDispatchEnabled: off by default, on only with FAST_DISPATCH=1", () => {
  assert.strictEqual(fastDispatchEnabled({}), false);
  assert.strictEqual(fastDispatchEnabled({ FAST_DISPATCH: "0" }), false);
  assert.strictEqual(fastDispatchEnabled({ FAST_DISPATCH: "1" }), true);
  // production mode never triggers on a garbage value
  assert.strictEqual(fastDispatchEnabled({ FAST_DISPATCH: "yes" }), false);
});

test("confirmRaceEnabled: probe OR production arms the race", () => {
  assert.strictEqual(confirmRaceEnabled({}), false);
  assert.strictEqual(confirmRaceEnabled({ CONFIRM_RACE_PROBE: "1" }), true);
  assert.strictEqual(confirmRaceEnabled({ FAST_DISPATCH: "1" }), true);
  assert.strictEqual(confirmRaceEnabled({ FAST_DISPATCH: "1", CONFIRM_RACE_PROBE: "0" }), true);
});

test("loadEnv: the race knobs flow from process.env (the Coolify env plumbing)", () => {
  const prevFast = process.env.FAST_DISPATCH;
  const prevProbe = process.env.CONFIRM_RACE_PROBE;
  try {
    process.env.FAST_DISPATCH = "1";
    process.env.CONFIRM_RACE_PROBE = "1";
    const env = loadEnv();
    assert.strictEqual(env.FAST_DISPATCH, "1");
    assert.strictEqual(env.CONFIRM_RACE_PROBE, "1");
    assert.strictEqual(fastDispatchEnabled(env), true);
    assert.strictEqual(confirmRaceEnabled(env), true);
  } finally {
    if (prevFast === undefined) delete process.env.FAST_DISPATCH;
    else process.env.FAST_DISPATCH = prevFast;
    if (prevProbe === undefined) delete process.env.CONFIRM_RACE_PROBE;
    else process.env.CONFIRM_RACE_PROBE = prevProbe;
  }
});
