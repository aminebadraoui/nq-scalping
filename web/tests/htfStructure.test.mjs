/* HTF swing structure (lib/htfStructure.ts) — daily/weekly HH/HL vs
 * LH/LL vs CHOP classification over synthetic bars. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyBars, weeklyBars, pivotHighs, pivotLows, classifyStructure, htfStructure } from "../lib/htfStructure.ts";

const mk = (day, high, low) => ({ t: `${day}T12:00:00`, high, low });

test("dailyBars: groups by ET day, newest last, extremes taken", () => {
  const bars = dailyBars([
    mk("2026-10-01", 102, 99),
    mk("2026-10-01", 103, 98),
    mk("2026-09-30", 101, 100),
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].day, "2026-09-30");
  assert.deepEqual([bars[1].high, bars[1].low], [103, 98]);
});

test("weeklyBars: groups Mon–Fri weeks keyed by Monday", () => {
  const daily = [
    { day: "2026-10-05", high: 100, low: 95 }, // Mon
    { day: "2026-10-06", high: 102, low: 96 }, // Tue
    { day: "2026-10-12", high: 104, low: 97 }, // next Mon
  ];
  const weeks = weeklyBars(daily);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].day, "2026-10-05");
  assert.deepEqual([weeks[0].high, weeks[0].low], [102, 95]);
  assert.equal(weeks[1].day, "2026-10-12");
});

test("pivots: fractal ±2 extremes", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, high: 100 + Math.sin(i / 2) * 5, low: 90 + Math.sin(i / 2) * 5 }));
  const hs = pivotHighs(bars);
  const ls = pivotLows(bars);
  assert.ok(hs.length >= 2 && ls.length >= 2);
  for (const i of hs) {
    assert.ok(bars[i].high > Math.max(bars[i - 1].high, bars[i - 2].high, bars[i + 1].high, bars[i + 2].high));
  }
});

test("classifyStructure: clean uptrend → HH/HL", () => {
  // rising stairs with pullbacks big enough to make fractal pivots
  const bars = [];
  let base = 100;
  for (let i = 0; i < 40; i++) {
    const up = i % 5 < 3;
    base += up ? 1.2 : -0.4;
    bars.push({ day: `d${i}`, high: base + 0.6, low: base - 0.6 });
  }
  assert.equal(classifyStructure(bars), "HH/HL");
});

test("classifyStructure: clean downtrend → LH/LL", () => {
  const bars = [];
  let base = 100;
  for (let i = 0; i < 40; i++) {
    const dn = i % 5 < 3;
    base += dn ? -1.2 : 0.4;
    bars.push({ day: `d${i}`, high: base + 0.6, low: base - 0.6 });
  }
  assert.equal(classifyStructure(bars), "LH/LL");
});

test("classifyStructure: compressed range → CHOP", () => {
  // wide early range, then 15 bars inside a tiny box
  const bars = [];
  for (let i = 0; i < 15; i++) bars.push({ day: `d${i}`, high: 100 + i * 2, low: 90 + i * 2 });
  for (let i = 15; i < 30; i++) bars.push({ day: `d${i}`, high: 131 + (i % 2), low: 129 });
  assert.equal(classifyStructure(bars), "CHOP");
});

test("classifyStructure: too few bars → CHOP (never crashes)", () => {
  assert.equal(classifyStructure([]), "CHOP");
  assert.equal(classifyStructure([{ day: "d1", high: 1, low: 0 }]), "CHOP");
});

test("htfStructure: minutes → daily + weekly labels", () => {
  const minutes = [];
  // 14 weeks, pattern 2 up-weeks (+4) then 1 pullback week (−5) — the
  // week-scale pullbacks create weekly pivots too, so HH/HL is nameable
  // at both timeframes
  let base = 100;
  let d = 0;
  let tradingDays = 0;
  while (tradingDays < 70) {
    const date = new Date(Date.UTC(2026, 0, 5 + d)); // Jan 5 2026 = Monday
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const w = Math.floor(tradingDays / 5);
      const weekDelta = w % 3 < 2 ? 4.0 : -5.0;
      base += weekDelta / 5;
      const day = date.toISOString().slice(0, 10);
      for (let hh = 0; hh < 4; hh++) minutes.push({ t: `${day}T${10 + hh}:00:00`, high: base + 0.6, low: base - 0.6 });
      tradingDays++;
    }
    d++;
  }
  const s = htfStructure(minutes);
  assert.equal(s.daily, "HH/HL");
  assert.equal(s.weekly, "HH/HL");
});
