/* Unit tests for the account guard: EOD-trailing floor, $100 lock, profit
 * target, the consistency ($900/day) cap, and the news-window ban.
 *
 * Consistency model: the FIRST observation of a day establishes the day-start
 * realized baseline; later observations measure profit against it. A single
 * reading cannot reveal the day's P&L. */
import { test } from "node:test";
import assert from "node:assert";
import { guardCheck, __resetGuardForTest, guardState } from "../lib/accountGuard";

function setStage(stage: "eval" | "funded") {
  process.env.MFF_STAGE = stage;
  __resetGuardForTest();
}

/** a NY timestamp helper: minute-of-day -> Date (2026-09-30 is a Wednesday) */
function at(minute: number): Date {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return new Date(Date.UTC(2026, 8, 30, h + 4, m, 0));
}

/** equity + realized; realized = equity when flat (no open P/L) */
const snap = (equity: number, realized = equity) => ({ equity, realized });

test("eval: no commit before the EOD hour — floor stays at start−loss", () => {
  setStage("eval");
  const d = guardCheck(snap(50_500), at(10 * 60));
  assert.equal(d.verdict, "ok");
  assert.equal(guardState().floor, 48_000);
});

test("eval: at/after EOD close the floor trails up with equity", () => {
  setStage("eval");
  guardCheck(snap(51_000), at(17 * 60 + 5));
  assert.equal(guardState().floor, 49_000);
  assert.equal(guardState().highWater, 51_000);
});

test("eval: floor never trails down (a later lower close keeps the higher floor)", () => {
  setStage("eval");
  guardCheck(snap(51_000), at(17 * 60 + 5));
  const d = guardCheck(snap(50_200), new Date(Date.UTC(2026, 8, 31, 17 + 4, 5, 0)));
  assert.equal(d.verdict, "ok");
  assert.equal(guardState().floor, 49_000);
});

test("eval: halt-floor once equity is within the guard margin of the floor", () => {
  setStage("eval");
  guardCheck(snap(51_000), at(17 * 60 + 5));
  const d = guardCheck(snap(49_300), at(17 * 60 + 6));
  assert.equal(d.verdict, "halt-floor");
});

test("eval: halt-target when equity reaches start + $3,000", () => {
  setStage("eval");
  const d = guardCheck(snap(53_000), at(10 * 60));
  assert.equal(d.verdict, "halt-target");
});

test("eval: consistency — day baseline established, then profit under $900 is ok", () => {
  setStage("eval");
  guardCheck(snap(50_000), at(9 * 60 + 30)); // day open: baseline 50,000
  const d = guardCheck(snap(50_800), at(12 * 60)); // +$800 realized
  assert.equal(d.verdict, "ok");
  assert.equal(guardState().dayPnl, 800);
});

test("eval: consistency — realized profit reaching $900 halts for the day", () => {
  setStage("eval");
  guardCheck(snap(50_000), at(9 * 60 + 30));
  const d = guardCheck(snap(50_900), at(12 * 60)); // +$900 realized
  assert.equal(d.verdict, "halt-consistency");
});

test("eval: consistency — realized profit over $900 also halts", () => {
  setStage("eval");
  guardCheck(snap(50_000), at(9 * 60 + 30));
  const d = guardCheck(snap(51_050), at(12 * 60)); // +$1,050 realized
  assert.equal(d.verdict, "halt-consistency");
});

test("eval: consistency resets on a new calendar day", () => {
  setStage("eval");
  // day 1: baseline 50,000, make +$800
  guardCheck(snap(50_000), at(9 * 60 + 30));
  guardCheck(snap(50_800), at(12 * 60));
  assert.equal(guardState().dayPnl, 800);
  // day 2: first observation establishes the new baseline (flat at 50,800 open)
  guardCheck(snap(50_800), new Date(Date.UTC(2026, 9, 1, 9 + 4, 30, 0)));
  assert.equal(guardState().dayPnl, 0); // new day, baseline just set
  // then make +$100 more
  const d = guardCheck(snap(50_900), new Date(Date.UTC(2026, 9, 1, 12 + 4, 0, 0)));
  assert.equal(d.verdict, "ok");
  assert.equal(guardState().dayPnl, 100);
});

test("eval: consistency day P/L uses REALIZED (open P/L excluded)", () => {
  setStage("eval");
  guardCheck(snap(50_000), at(9 * 60 + 30));
  // equity 51,200 but realized 50,400 → only +$400 counted (open P/L $800 floats)
  const d = guardCheck(snap(51_200, 50_400), at(12 * 60));
  assert.equal(guardState().dayPnl, 400);
  assert.equal(d.verdict, "ok");
});

test("eval: consistency records best-day P&L across rollovers", () => {
  setStage("eval");
  guardCheck(snap(50_000), at(9 * 60 + 30)); // day 1 baseline
  guardCheck(snap(50_600), at(12 * 60)); // +$600
  guardCheck(snap(50_600), new Date(Date.UTC(2026, 9, 1, 9 + 4, 30, 0))); // day 2 baseline=50,600
  assert.equal(guardState().bestDayPnl, 600);
});

test("funded: consistency cap does NOT apply (no consistency rule when funded)", () => {
  setStage("funded");
  guardCheck(snap(0), at(9 * 60 + 30));
  const d = guardCheck(snap(1_000), at(12 * 60)); // realized +$1,000 today
  assert.equal(d.verdict, "ok");
});

test("funded: floor locks at $100 and stops trailing", () => {
  setStage("funded");
  guardCheck(snap(1_000), at(17 * 60 + 5));
  assert.equal(guardState().floor, -1000);
  guardCheck(snap(2_500), new Date(Date.UTC(2026, 8, 31, 17 + 4, 5, 0)));
  assert.equal(guardState().locked, true);
  assert.equal(guardState().floor, 100);
  guardCheck(snap(10_000), new Date(Date.UTC(2026, 9, 1, 17 + 4, 5, 0)));
  assert.equal(guardState().floor, 100);
});

test("funded: T1 news window blocks trading", () => {
  setStage("funded");
  process.env.MFF_T1_NEWS = "2026-09-30 08:30";
  const d = guardCheck(snap(1_000), at(8 * 60 + 31));
  assert.equal(d.verdict, "halt-news");
  delete process.env.MFF_T1_NEWS;
});

test("funded: T1 news window is NOT blocked on a different day or eval", () => {
  setStage("funded");
  process.env.MFF_T1_NEWS = "2026-09-30 08:30";
  const d = guardCheck(snap(1_000), new Date(Date.UTC(2026, 9, 1, 8 + 4, 31, 0)));
  assert.equal(d.verdict, "ok");
  delete process.env.MFF_T1_NEWS;
});

test("no-data: null equity halts (never trade blind)", () => {
  setStage("eval");
  const d = guardCheck(null, at(10 * 60));
  assert.equal(d.verdict, "no-data");
});
