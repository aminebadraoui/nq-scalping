/* Unit tests for the account guard: EOD-trailing floor, $100 lock, profit
 * target, the consistency ($900/day) cap, and the news-window ban.
 *
 * Consistency model: the FIRST observation of a day establishes the day-start
 * realized baseline; later observations measure profit against it. A single
 * reading cannot reveal the day's P&L. */
import { test } from "node:test";
import assert from "node:assert";
import { guardCheck, __resetGuardForTest, guardState, tradingDayKey, guardStage, hydrateFieldsFrom } from "../lib/accountGuard";

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

test("funded: the +$900/day consistency cap APPLIES (the same rules run on funded)", () => {
  setStage("funded");
  guardCheck(snap(0), at(9 * 60 + 30));
  const below = guardCheck(snap(500), at(12 * 60)); // realized +$500 today
  assert.equal(below.verdict, "ok");
  const d = guardCheck(snap(1_000), at(13 * 60)); // realized +$1,000 today → over the cap
  assert.equal(d.verdict, "halt-consistency");
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

test("give-back protection: halts after giving back more than max(floor, pct × peak)", () => {
  __resetGuardForTest();
  const oldPct = process.env.GUARD_GIVEBACK_PCT;
  const oldFloor = process.env.GUARD_GIVEBACK_FLOOR;
  process.env.GUARD_GIVEBACK_PCT = "0.5";
  process.env.GUARD_GIVEBACK_FLOOR = "250";
  process.env.PROFIT_ARM = "0"; // isolate give-back from the day-plan arm
  try {
    // day baseline first, then climb to a $600 day profit
    guardCheck({ equity: 50_000, realized: 0 }, new Date("2026-10-02T16:00:00-04:00"));
    assert.equal(guardCheck({ equity: 50_600, realized: 600 }, new Date("2026-10-02T17:00:00-04:00")).verdict, "ok");
    // give back $300 of the $600 peak → limit max(250, 300) = 300 → dayPnl 300 <= 600-300 → halt
    const d = guardCheck({ equity: 50_300, realized: 300 }, new Date("2026-10-02T17:05:00-04:00"));
    assert.equal(d.verdict, "halt-giveback");
  } finally {
    if (oldPct === undefined) delete process.env.GUARD_GIVEBACK_PCT;
    else process.env.GUARD_GIVEBACK_PCT = oldPct;
    if (oldFloor === undefined) delete process.env.GUARD_GIVEBACK_FLOOR;
    else process.env.GUARD_GIVEBACK_FLOOR = oldFloor;
    delete process.env.PROFIT_ARM;
    delete process.env.DAILY_LOSS_FLOOR;
    __resetGuardForTest();
  }
});

test("give-back protection: the floor guards small peaks; pct=0 disables", () => {
  __resetGuardForTest();
  const oldPct = process.env.GUARD_GIVEBACK_PCT;
  const oldFloor = process.env.GUARD_GIVEBACK_FLOOR;
  try {
    process.env.GUARD_GIVEBACK_PCT = "0.5";
    process.env.GUARD_GIVEBACK_FLOOR = "250";
    process.env.PROFIT_ARM = "0"; // isolate give-back from the day-plan arm
    process.env.DAILY_LOSS_FLOOR = "0"; // isolate give-back from the daily floor
    // small day: peak 200 <= floor 250 → no halt even at $0
    guardCheck({ equity: 50_000, realized: 0 }, new Date("2026-10-02T16:00:00-04:00"));
    assert.equal(guardCheck({ equity: 50_200, realized: 200 }, new Date("2026-10-02T17:00:00-04:00")).verdict, "ok");
    assert.equal(guardCheck({ equity: 50_000, realized: 0 }, new Date("2026-10-02T17:05:00-04:00")).verdict, "ok");

    __resetGuardForTest();
    process.env.GUARD_GIVEBACK_PCT = "0"; // disabled
    guardCheck({ equity: 50_600, realized: 600 }, new Date("2026-10-03T17:00:00-04:00"));
    assert.equal(guardCheck({ equity: 50_000, realized: 0 }, new Date("2026-10-03T17:05:00-04:00")).verdict, "ok");
  } finally {
    if (oldPct === undefined) delete process.env.GUARD_GIVEBACK_PCT;
    else process.env.GUARD_GIVEBACK_PCT = oldPct;
    if (oldFloor === undefined) delete process.env.GUARD_GIVEBACK_FLOOR;
    else process.env.GUARD_GIVEBACK_FLOOR = oldFloor;
    delete process.env.PROFIT_ARM;
    delete process.env.DAILY_LOSS_FLOOR;
    __resetGuardForTest();
  }
});

test("trading day rolls at the Globex open (18:00 ET), not midnight", () => {
  __resetGuardForTest();
  setStage("eval");
  // 22:00 ET Oct 2: session day key = 2026-10-02 (tonight's session)
  guardCheck(snap(50_000), new Date("2026-10-03T02:00:00Z")); // 22:00 ET Oct 2
  guardCheck(snap(50_500), new Date("2026-10-03T02:30:00Z"));
  assert.equal(guardState().dayPnl, 500);
  // 01:00 ET Oct 3 (after midnight, BEFORE 18:00): SAME trading day — no reset
  guardCheck(snap(50_600), new Date("2026-10-03T05:00:00Z")); // 01:00 ET Oct 3
  assert.equal(guardState().dayPnl, 600, "pre-Globex hours belong to yesterday's session");
  // 18:30 ET Oct 3: the Globex open rolls the day
  guardCheck(snap(50_600), new Date("2026-10-03T22:30:00Z")); // 18:30 ET Oct 3
  assert.equal(guardState().dayPnl, 0, "day resets at the Globex open");
  __resetGuardForTest();
});

test("tradingDayKey: before 18:00 belongs to yesterday's session", () => {
  // 01:00 ET Oct 3 = 05:00Z Oct 3 → session key 2026-10-02
  assert.equal(tradingDayKey(new Date("2026-10-03T05:00:00Z")), "2026-10-02");
  // 22:00 ET Oct 2 = 02:00Z Oct 3 → session key 2026-10-02
  assert.equal(tradingDayKey(new Date("2026-10-03T02:00:00Z")), "2026-10-02");
  // 18:30 ET Oct 2 = 22:30Z Oct 2 → session key 2026-10-02
  assert.equal(tradingDayKey(new Date("2026-10-02T22:30:00Z")), "2026-10-02");
});

test("daily loss floor (DAILY_LOSS_FLOOR) halts once the day crosses it", () => {
  __resetGuardForTest();
  setStage("eval");
  process.env.DAILY_LOSS_FLOOR = "400";
  // first observation establishes the day-start realized baseline
  assert.equal(guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z")).verdict, "ok");
  // still above the floor
  assert.equal(guardCheck(snap(49_800), new Date("2026-10-05T17:01:00Z")).verdict, "ok");
  // −$400 → halt
  assert.equal(guardCheck(snap(49_600), new Date("2026-10-05T17:02:00Z")).verdict, "halt-daily-floor");
  delete process.env.DAILY_LOSS_FLOOR;
  __resetGuardForTest();
});

test("daily loss floor defaults to −$250 (the day plan); DAILY_LOSS_FLOOR=0 disables", () => {
  __resetGuardForTest();
  setStage("eval");
  delete process.env.DAILY_LOSS_FLOOR;
  guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z"));
  // −$250 is the default: crossing it halts
  assert.equal(guardCheck(snap(49_740), new Date("2026-10-05T17:02:00Z")).verdict, "halt-daily-floor");
  __resetGuardForTest();
  process.env.DAILY_LOSS_FLOOR = "0";
  guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z"));
  assert.equal(guardCheck(snap(49_600), new Date("2026-10-05T17:02:00Z")).verdict, "ok");
  delete process.env.DAILY_LOSS_FLOOR;
  __resetGuardForTest();
});

test("profit arm: crossing +$400 arms; a win after arming keeps trading", () => {
  __resetGuardForTest();
  setStage("eval");
  guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z"));
  assert.equal(guardCheck(snap(50_420), new Date("2026-10-05T17:05:00Z")).verdict, "ok");
  assert.equal(guardState().profitArmed, true);
  // a WIN after arming grants one more
  assert.equal(guardCheck(snap(50_700), new Date("2026-10-05T17:06:00Z")).verdict, "ok");
});

test("profit arm: the first LOSS after arming halts the day", () => {
  __resetGuardForTest();
  setStage("eval");
  guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z"));
  guardCheck(snap(50_420), new Date("2026-10-05T17:05:00Z"));
  assert.equal(guardCheck(snap(50_250), new Date("2026-10-05T17:06:00Z")).verdict, "halt-profit-arm");
});

test("profit arm resets on a new trading day", () => {
  __resetGuardForTest();
  setStage("eval");
  guardCheck(snap(50_000), new Date("2026-10-05T17:00:00Z"));
  guardCheck(snap(50_420), new Date("2026-10-05T17:05:00Z"));
  assert.equal(guardState().profitArmed, true);
  // next calendar day: arm resets, no halt on the new baseline
  const d = guardCheck(snap(50_250), new Date("2026-10-06T17:00:00Z"));
  assert.equal(d.verdict, "ok");
  assert.equal(guardState().profitArmed, false);
  __resetGuardForTest();
});

test("dd600→half: deep drawdown from the trailing reference sets ddHalved; recovery clears it", () => {
  __resetGuardForTest();
  setStage("eval");
  // day 1: EOD commit at 51_000 → highWater 51_000, floor 49_000
  guardCheck(snap(51_000), at(17 * 60 + 5));
  assert.equal(guardState().highWater, 51_000);
  // day 2 opens flat at 50_000: $1,000 below the reference → ddHalved
  guardCheck(snap(50_000), new Date(Date.UTC(2026, 9, 1, 9 + 4, 30, 0)));
  assert.equal(guardState().ddHalved, true);
  // recovers to $200 below the reference → cleared
  guardCheck(snap(50_800), new Date(Date.UTC(2026, 9, 1, 12 + 4, 0, 0)));
  assert.equal(guardState().ddHalved, false);
  __resetGuardForTest();
});

test("dd halving is inert when DD_HALF_AT=0", () => {
  __resetGuardForTest();
  setStage("eval");
  process.env.DD_HALF_AT = "0";
  guardCheck(snap(51_000), at(17 * 60 + 5));
  guardCheck(snap(50_000), new Date(Date.UTC(2026, 9, 1, 9 + 4, 30, 0)));
  assert.equal(guardState().ddHalved, false);
  delete process.env.DD_HALF_AT;
  __resetGuardForTest();
});

test("guardStage: MFF_STAGE env overrides; absent → derived from the account name", () => {
  process.env.MFF_STAGE = "funded";
  process.env.CROSSTRADE_ACCOUNT = "MFFUEVREOD706880007"; // eval name
  assert.equal(guardStage(), "funded", "env override wins over the name");
  delete process.env.MFF_STAGE;
  assert.equal(guardStage(), "eval", "EV name without env → eval");
  process.env.CROSSTRADE_ACCOUNT = "MFFUSFREOD706880008";
  assert.equal(guardStage(), "funded", "SF name without env → funded");
  delete process.env.CROSSTRADE_ACCOUNT;
  assert.equal(guardStage(), "eval", "missing name → conservative eval");
  __resetGuardForTest();
});

test("seed: a funded account name without MFF_STAGE seeds funded rules", () => {
  process.env.CROSSTRADE_ACCOUNT = "MFFUSFREOD706880008";
  delete process.env.MFF_STAGE;
  __resetGuardForTest();
  const s = guardState();
  assert.equal(s.stage, "funded");
  assert.equal(s.account, "MFFUSFREOD706880008");
  assert.equal(s.startBalance, 0);
  assert.equal(s.floor, -2000);
  assert.equal(s.lockAt, 100);
  delete process.env.CROSSTRADE_ACCOUNT;
  __resetGuardForTest();
});

test("hydrateFieldsFrom: another account's row is ignored wholesale", () => {
  assert.equal(
    hydrateFieldsFrom({ account: "MFFUEVREOD706880007", floor: 51009.2, highWater: 53009.2, stage: "eval" }, "MFFUSFREOD706880008"),
    null,
    "the old eval account's trailing state must never leak into the new account",
  );
});

test("hydrateFieldsFrom: same-account rows restore trailing/day state; derived rule fields never come from the DB", () => {
  const h = hydrateFieldsFrom(
    {
      account: "MFFUEVREOD706880007",
      stage: "funded", // a stale derived field — must NOT be restored
      startBalance: 123, // ditto
      maxLoss: 999,
      profitTarget: 9999,
      consistencyCap: 888,
      lockAt: 7,
      floor: 51009.2,
      highWater: 53009.2,
      locked: true,
      lastCommitDay: "2026-10-10",
      dayKey: "2026-10-11",
      dayStartRealized: -899,
      bestDayPnl: 899.4,
      dayPeak: 300,
      profitArmed: true,
      lastDayPnl: 250,
      ddHalved: true,
    },
    "MFFUEVREOD706880007",
  );
  assert.ok(h);
  assert.equal(h.floor, 51009.2);
  assert.equal(h.highWater, 53009.2);
  assert.equal(h.locked, true);
  assert.equal(h.lastCommitDay, "2026-10-10");
  assert.equal(h.dayKey, "2026-10-11");
  assert.equal(h.dayStartRealized, -899);
  assert.equal(h.bestDayPnl, 899.4);
  assert.equal(h.dayPeak, 300);
  assert.equal(h.profitArmed, true);
  assert.equal(h.lastDayPnl, 250);
  assert.equal(h.ddHalved, true);
  for (const derived of ["stage", "startBalance", "maxLoss", "profitTarget", "consistencyCap", "lockAt"]) {
    assert.equal(derived in h, false, `${derived} must never be restored from the DB row`);
  }
});

test("hydrateFieldsFrom: legacy rows without an account field still restore", () => {
  const h = hydrateFieldsFrom({ floor: 48000, highWater: 50000 }, "MFFUEVREOD706880007");
  assert.ok(h, "pre-account rows keep restoring (backward compatible)");
  assert.equal(h.floor, 48000);
});
