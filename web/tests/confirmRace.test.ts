/* Unit tests for the confirmation-race probe's pure outcome formatter
 * (lib/live.ts formatConfirmRace) — the race itself is a live-only
 * measurement; the formatter is what the logs and operator read. */
import { test } from "node:test";
import assert from "node:assert";
import { formatConfirmRace } from "../lib/live";

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
