/* Signal outcome scorer (lib/signalScorer.ts) — the win/loss replay of a
 * recorded signal against minute bars: entry at the signal bar, pessimistic
 * first-touch resolution, time exit after the hold window. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreSignalBars } from "../lib/signalScorer.ts";

const mk = (t, high, low, close = (high + low) / 2) => ({ t, high, low, close });

test("long: target touched first → win", () => {
  const bars = [
    mk("10:00", 100, 99),
    mk("10:01", 101, 100),
    mk("10:02", 103, 101.5), // target 102 hit, stop 98.5 not
  ];
  const r = scoreSignalBars(bars, "10:00", "long", 100.25, 98.5, 102, { holdBars: 10 });
  assert.equal(r.outcome, "win");
  assert.equal(r.exitPrice, 102);
  assert.equal(r.exitReason, "target");
  assert.equal(r.exitTime, "10:02");
  assert.ok((r.mfePts ?? 0) >= 2.75);
});

test("long: stop touched first → loss", () => {
  const bars = [
    mk("10:00", 100, 99),
    mk("10:01", 99.5, 98), // stop 98.5 hit
    mk("10:02", 101, 99),
  ];
  const r = scoreSignalBars(bars, "10:00", "long", 100, 98.5, 103, { holdBars: 10 });
  assert.equal(r.outcome, "loss");
  assert.equal(r.exitPrice, 98.5);
  assert.equal(r.exitReason, "stop");
});

test("same bar spans stop AND target → pessimistic stop first", () => {
  const bars = [mk("10:00", 100, 99), mk("10:01", 104, 97)]; // spans stop 98 + target 103
  const r = scoreSignalBars(bars, "10:00", "long", 100, 98, 103, { holdBars: 10 });
  assert.equal(r.outcome, "loss");
  assert.equal(r.exitReason, "stop");
});

test("short mirror: target below, stop above", () => {
  const bars = [mk("10:00", 100, 99), mk("10:01", 99, 97.5)]; // target 98 hit
  const r = scoreSignalBars(bars, "10:00", "short", 99.5, 102, 98, { holdBars: 10 });
  assert.equal(r.outcome, "win");
  assert.equal(r.exitPrice, 98);
});

test("no touch within the window → time exit at the last close", () => {
  const tOf = (i) => `${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
  const bars = Array.from({ length: 62 }, (_, i) => mk(tOf(i), 101, 99, 100 + (i % 3) * 0.25));
  const r = scoreSignalBars(bars, "10:00", "long", 100, 97, 104, { holdBars: 60, completeSession: true });
  assert.equal(r.exitReason, "time");
  assert.equal(r.exitTime, tOf(60)); // start+60 → bar 60 (11:00)
  assert.equal(r.exitPrice, bars[60].close);
});

test("incomplete (live) bars running out → open", () => {
  const bars = [mk("10:00", 100, 99), mk("10:01", 100.5, 99.5)];
  const r = scoreSignalBars(bars, "10:00", "long", 100, 98, 103, { holdBars: 60, completeSession: false });
  assert.equal(r.outcome, "open");
  assert.equal(r.exitReason, null);
});

test("unscored: missing entry bar, non-numeric levels, or invalid geometry", () => {
  assert.equal(scoreSignalBars([mk("11:00", 100, 99)], "10:00", "long", 100, 98, 103, { holdBars: 5 }).outcome, "");
  assert.equal(scoreSignalBars([mk("10:00", 100, 99)], "10:00", "long", NaN, 98, 103, { holdBars: 5 }).outcome, "");
  assert.equal(scoreSignalBars([mk("10:00", 100, 99)], "10:00", "long", 100, 105, 103, { holdBars: 5 }).outcome, "");
  assert.equal(scoreSignalBars([], "10:00", "long", 100, 98, 103, { holdBars: 5 }).outcome, "");
});
