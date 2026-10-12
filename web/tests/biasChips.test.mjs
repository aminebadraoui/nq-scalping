/* Bias chips (lib/biasChips.ts) — pure-function tests over synthetic
 * 1-minute bars (CT times, the archive convention). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alnPattern, gapRegime, gapChipScore, vixFadeGate, priorDayPosChip, biasChips, sideLeanChips } from "../lib/biasChips.ts";

const bar = (t, high, low, c, o = c) => ({ t, o, c, high, low });

/* ---- ALN classification ---- */

/** Asia 20:00–02:00 ET = 19:00–00:59 CT · London 02:00–08:00 ET = 01:00–06:59 CT.
 *  The classifier needs ≥30 bars per range (thin-session guard), so the
 *  fixtures generate minute bars on a 10-min grid (~36 bars per range). */
const expand = (startH, startM, count, mk) => {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (startH + Math.floor((startM + i * 10) / 60)) % 24;
    const m = (startM + i * 10) % 60;
    out.push(mk(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`));
  }
  return out;
};

test("P2: Asia range fully contains London (rarest)", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 101, 99, 100)), // Asia 99–101
    ...expand(1, 0, 36, (t) => bar(t, 100.5, 99.5, 100)), // London inside Asia
  ];
  assert.equal(alnPattern(mins), "P2");
});

test("P3: London pushes above Asia but not below", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 100, 98, 99)), // Asia 98–100
    ...expand(1, 0, 36, (t) => bar(t, 102, 99, 101)), // London 99–102: above, low holds
  ];
  assert.equal(alnPattern(mins), "P3");
});

test("P4: London pushes below Asia but not above", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 101, 99, 100)), // Asia 99–101
    ...expand(1, 0, 36, (t) => bar(t, 100, 97, 98)), // London 97–100: below, high holds
  ];
  assert.equal(alnPattern(mins), "P4");
});

test("P1: London engulfs Asia", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 101, 99, 100)), // Asia 99–101
    ...expand(1, 0, 36, (t) => bar(t, 102, 97, 100)), // London 97–102: full engulf
  ];
  assert.equal(alnPattern(mins), "P1");
});

test("alnPattern: null when a session is too thin", () => {
  assert.equal(alnPattern([bar("19:00", 101, 99, 100), bar("01:00", 100, 98, 99)]), null);
});

/* ---- gap regime + score ---- */

test("gapRegime buckets", () => {
  assert.equal(gapRegime(0.2), "small");
  assert.equal(gapRegime(-0.4), "small");
  assert.equal(gapRegime(1.0), "mid");
  assert.equal(gapRegime(1.5), "mid");
  assert.equal(gapRegime(2.1), "large");
  assert.equal(gapRegime(null), null);
});

test("small gap fades AGAINST the gap; large gap rides WITH it (VIX-gated)", () => {
  assert.equal(gapChipScore(-0.3, true), 2); // gap down → fade up = bullish
  assert.equal(gapChipScore(0.3, true), -2); // gap up → fade down = bearish
  assert.equal(gapChipScore(0.8, true), 0); // mid: no default
  assert.equal(gapChipScore(2.0, true), 2); // large up → with-gap bullish
  assert.equal(gapChipScore(-2.0, true), -2);
  assert.equal(gapChipScore(2.0, false), 0); // large but VIX gate off → no bias
});

/* ---- VIX fade gate ---- */

test("contango & VIX<25 → fades valid (+1); backwardation or ≥25 → −1", () => {
  assert.deepEqual(vixFadeGate(14, 18), { fadeOk: true, score: 1, label: "VIX 14.0 contango (3M +4.0) → fades valid" });
  assert.equal(vixFadeGate(14, 13).fadeOk, false);
  assert.equal(vixFadeGate(30, 34).fadeOk, false);
  assert.equal(vixFadeGate(null, null).score, 0);
});

/* ---- prior-day position ---- */

test("priorDayPosChip: above PDH +1, below PDL −1, inside 0", () => {
  assert.equal(priorDayPosChip(101, 100, 95).pos, "abovePDH");
  assert.equal(priorDayPosChip(94, 100, 95).pos, "belowPDL");
  assert.equal(priorDayPosChip(98, 100, 95).pos, "inside");
  assert.equal(priorDayPosChip(null, 100, 95).pos, null);
});

/* ---- one-sided sideLean rules (side-filter study) ---- */

test("sideLeanChips: mid gaps → longs, large gap up → shorts, P3+bear → longs", () => {
  assert.ok(sideLeanChips({ regime: "mid", gapPct: -0.8 }, null, {}).some((l) => l.includes("gap mid-down")));
  assert.ok(sideLeanChips({ regime: "mid", gapPct: 0.8 }, null, {}).some((l) => l.includes("gap mid-up")));
  assert.ok(sideLeanChips({ regime: "large", gapPct: 2.0 }, null, {}).some((l) => l.includes("SHORT-ONLY gap large-up")));
  assert.ok(sideLeanChips({ regime: "large", gapPct: -2.0 }, null, {}).some((l) => l.includes("LONG-LEAN gap large-down")));
  assert.ok(sideLeanChips({ regime: "small", gapPct: 0.2 }, "P3", { htfDaily: "bear" }).some((l) => l.includes("P3+bear")));
});

test("sideLeanChips: P2 → longs, P4 late-night → shorts, pre-open suppressed on event days", () => {
  assert.ok(sideLeanChips({ regime: "small", gapPct: 0.1 }, "P2", {}).some((l) => l.includes("ALN P2")));
  assert.ok(sideLeanChips({ regime: "small", gapPct: 0.1 }, "P4", { hourET: 23 }).some((l) => l.includes("P4 23–02")));
  assert.ok(!sideLeanChips({ regime: "small", gapPct: 0.1 }, "P4", { hourET: 10 }).some((l) => l.includes("P4 23–02")));
  assert.ok(sideLeanChips({ regime: "small", gapPct: 0.1 }, null, { hourET: 8, eventDay: false }).some((l) => l.includes("08–09")));
  assert.equal(sideLeanChips({ regime: "small", gapPct: 0.1 }, null, { hourET: 8, eventDay: true }).some((l) => l.includes("08–09")), false);
});

test("biasChips: sideLean leads the chip list and score is unchanged", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 100, 98, 99)), // Asia 98–100
    ...expand(1, 0, 36, (t) => bar(t, 101, 99, 100)), // P3
    bar("07:30", 100.5, 99.5, 100.2),
  ];
  // mid gap up (+0.2%? no — 100.2 vs 100.0 = small). Use prior close 99.4 → +0.80% mid up.
  const chips = biasChips(mins, 99.4, 101.5, 98.5, 14, 18, { hourET: 10, htfDaily: "bear", eventDay: false });
  assert.equal(chips.sideLean[0], "LONG-ONLY gap mid-up 81%");
  assert.ok(chips.sideLean.some((l) => l.includes("P3+bear")));
  assert.equal(chips.chips[0], "LONG-ONLY gap mid-up 81%");
  assert.equal(chips.score, chips.gap.score + chips.aln.score + chips.priorDay.score + chips.vixGate.score);
});

test("biasChips: P3 + small gap-up + inside prior range + contango", () => {
  const mins = [
    ...expand(19, 0, 36, (t) => bar(t, 100, 98, 99)), // Asia 98–100
    ...expand(1, 0, 36, (t) => bar(t, 101, 99, 100)), // P3: London above Asia, low 99 > 98
    bar("07:30", 100.5, 99.5, 100.2), // latest minute
  ];
  const chips = biasChips(mins, 100.0, 101.5, 98.5, 14, 18);
  assert.equal(chips.aln.pattern, "P3");
  assert.equal(chips.gap.regime, "small"); // +0.2%
  assert.equal(chips.priorDay.pos, "inside"); // 100.2 inside 98.5–101.5
  assert.equal(chips.vixGate.fadeOk, true);
  // gap small up → −2 · aln P3 +2 · priorDay 0 · vix +1 = +1
  assert.equal(chips.score, 1);
  assert.equal(chips.chips.length, 4);
});
