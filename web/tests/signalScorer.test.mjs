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

test("resting-limit card: no trade-through within the fill window → nofill (never a paper win)", () => {
  const bars = [
    { t: "10:00", high: 105, low: 104, close: 104.5 },
    { t: "10:01", high: 112, low: 104, close: 111 }, // runs to the target, never trades 100
    { t: "10:02", high: 113, low: 108, close: 110 },
  ];
  const o = scoreSignalBars(bars, "10:00", "long", 100, 97, 106, { marketPrice: 104.5 });
  assert.equal(o.outcome, "nofill");
});

test("resting-limit card: the fill bar checks the stop first and never credits the target", () => {
  const bars = [
    { t: "10:00", high: 105, low: 104, close: 104.5 },
    { t: "10:01", high: 107, low: 96, close: 100 }, // fills 100, spans stop 97 and target 106
  ];
  const o = scoreSignalBars(bars, "10:00", "long", 100, 97, 106, { marketPrice: 104.5 });
  assert.equal(o.outcome, "loss");
});

test("resting-limit card: filled on a trade-through, target on a later bar", () => {
  const bars = [
    { t: "10:00", high: 105, low: 104, close: 104.5 },
    { t: "10:01", high: 104, low: 99.5, close: 101 },
    { t: "10:02", high: 107, low: 100, close: 106 },
  ];
  const o = scoreSignalBars(bars, "10:00", "long", 100, 97, 106, { marketPrice: 104.5 });
  assert.equal(o.outcome, "win");
});

test("trigger card above the market (buy-stop): fills only when price reaches the trigger", () => {
  const bars = [
    { t: "10:00", high: 101, low: 100, close: 100.5 },
    { t: "10:01", high: 101.5, low: 99, close: 100 }, // below the 102 trigger: no fill (the old rule "filled" it here)
    { t: "10:02", high: 103, low: 101, close: 102.5 }, // reaches 102 → fill bar (no target credit)
    { t: "10:03", high: 106, low: 102, close: 105 },
  ];
  const o = scoreSignalBars(bars, "10:00", "long", 102, 100.5, 105, { marketPrice: 100.5 });
  assert.equal(o.outcome, "win");
  assert.equal(o.exitTime, "10:03");
});

test("live bars: a pending limit still inside its fill window is open, not nofill", () => {
  const bars = [
    { t: "10:00", high: 105, low: 104, close: 104.5 },
    { t: "10:01", high: 105, low: 103, close: 104 },
  ];
  const o = scoreSignalBars(bars, "10:00", "long", 100, 97, 106, { marketPrice: 104.5, completeSession: false });
  assert.equal(o.outcome, "open");
});
