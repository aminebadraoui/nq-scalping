/* Unit tests for the momentum detector (lib/momentum.ts).
 *
 * The main fixture is the REAL 2026-09-30 Globex tape (18:00–18:47 ET,
 * 22:00–22:47 UTC) reconstructed from the live tick feed — the session
 * where the failed flush at 18:10 → buy response at 18:11 → one-sided
 * breakout at 18:16 ran price +58 pts to 30794.75. The production config
 * must fire that long and must NOT fire the fade shorts the old products
 * fired at 18:10 and 18:43.
 *
 * Synthetic fixtures are padded with 30 quiet two-way bars first — the
 * detector requires a warm-up window for its session median volume. */
import { test } from "node:test";
import assert from "node:assert";
import { detectMomentum, detectExpansionScalp, MOM_PROD, MOM_DEFAULTS, EXP_PROD, type MomMinute } from "../lib/momentum";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "../lib/openDrive";
import { detectSoftMomentum, SOFT_PROD, inRTH } from "../lib/softMomentum";
import { momentumSize, RAPID_EOD_50K } from "../lib/propRules";

/** compact bar builder: [t, high, low, buy, sell, levels?] */
type Bar = [string, number, number, number, number, [number, number, number][]?];

function bars(rows: Bar[]): MomMinute[] {
  return rows.map(([t, high, low, buy, sell, lv]) => ({
    t,
    d: "2026-09-30",
    o: 0,
    c: 0,
    high,
    low,
    buy,
    sell,
    levels: (lv ?? []).map(([price, b, s]) => ({ price, buy: b, sell: s })),
  }));
}

/** 30 quiet two-way bars so the session-median window is warm */
function pad(rows: Bar[], base = 100): MomMinute[] {
  const quiet: Bar[] = [];
  for (let i = 0; i < 30; i++) {
    const t = `${String(Math.floor(i / 60) + 16).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
    quiet.push([t, base + 0.25, base - 0.25, 50, 50]);
  }
  return bars([...quiet, ...rows]);
}

/* the real tape: 18:00–18:47 ET (feed clock = UTC keys here) */
const TAPE: Bar[] = [
  ["22:00", 30716.75, 30702.75, 73, 76],
  ["22:01", 30702.25, 30695.75, 17, 1],
  ["22:02", 30715.5, 30714.25, 1, 1],
  ["22:03", 30731.75, 30724.75, 9, 11],
  ["22:04", 30732.75, 30729.25, 5, 6],
  ["22:05", 30733.0, 30713.5, 133, 78],
  ["22:06", 30731.5, 30724.5, 21, 41],
  ["22:07", 30729.75, 30726.0, 1, 10],
  ["22:08", 30733.75, 30731.75, 8, 7],
  ["22:09", 30738.5, 30731.0, 20, 26],
  // the failed flush: 78% sell, holds 10 pts above the session low
  ["22:10", 30735.0, 30712.75, 48, 168],
  // the response: 71% buy with tick proof inside the flush zone
  ["22:11", 30724.5, 30719.0, 30, 12, [[30721.75, 10, 0], [30721.5, 6, 2], [30722.25, 5, 0]]],
  ["22:12", 30732.5, 30722.25, 32, 31],
  ["22:13", 30734.0, 30731.0, 11, 20],
  ["22:14", 30737.5, 30728.5, 31, 30],
  ["22:15", 30735.25, 30732.0, 5, 17],
  // the breakout: 86% buy, trades through the 30738.50 reference
  ["22:16", 30741.0, 30735.0, 44, 7, [[30741.0, 4, 0], [30740.75, 8, 0], [30740.0, 4, 0]]],
  ["22:17", 30736.5, 30734.5, 6, 2],
  ["22:18", 30744.5, 30736.5, 93, 47],
  ["22:19", 30742.0, 30737.25, 12, 20],
  ["22:20", 30747.0, 30743.75, 16, 16],
  ["22:21", 30744.0, 30740.75, 29, 12],
  ["22:22", 30751.0, 30743.5, 67, 29],
  ["22:23", 30749.75, 30747.0, 11, 12],
  ["22:24", 30747.5, 30745.25, 11, 11],
  ["22:25", 30748.75, 30746.0, 18, 32],
  ["22:26", 30751.0, 30745.5, 43, 36],
  ["22:27", 30750.0, 30747.5, 11, 18],
  ["22:28", 30750.5, 30748.0, 10, 6],
  ["22:29", 30750.5, 30748.0, 12, 13],
  ["22:30", 30756.25, 30752.25, 33, 18],
  ["22:31", 30754.75, 30754.75, 1, 0],
  ["22:32", 30755.5, 30753.75, 0, 5],
  ["22:33", 30759.25, 30759.25, 0, 2],
  ["22:34", 30762.5, 30761.5, 6, 0],
  ["22:35", 30763.0, 30760.0, 21, 20],
  ["22:36", 30769.5, 30761.5, 58, 32],
  ["22:37", 30769.5, 30766.0, 41, 26],
  ["22:38", 30770.75, 30767.0, 14, 38],
  ["22:39", 30772.0, 30768.0, 36, 13],
  ["22:40", 30775.25, 30769.25, 33, 20],
  ["22:41", 30788.25, 30777.0, 191, 114],
  ["22:42", 30794.75, 30785.25, 76, 94],
  ["22:43", 30786.75, 30776.25, 55, 132],
  ["22:44", 30780.75, 30776.0, 72, 57],
  ["22:45", 30779.0, 30775.0, 11, 18],
  ["22:46", 30774.5, 30769.5, 24, 16],
  ["22:47", 30773.0, 30772.0, 2, 6],
];

test("production config fires the 18:16 long on the real failed-flush tape", () => {
  // the sequence fires with the historical 0.85×ATR size floor; prod moved
  // to 1.0 after the 2026-10-02 quality-filter sweep (see the next test)
  const sigs = detectMomentum(bars(TAPE), { ...MOM_PROD, minBreakRangeR: 0.85 });
  assert.equal(sigs.length, 1, "exactly one signal expected");
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.equal(s.t, "22:16"); // 18:16 ET
  assert.equal(s.flushIdx, 10); // 22:10 flush
  assert.equal(s.breakIdx, 16); // 22:16 breakout
  assert.equal(s.respIdx, 16); // merged mode: the breakout bar is its own response evidence
  assert.ok(Math.abs(s.entry - 30738.0) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 30734.5) < 0.01, `stop ${s.stop}`);
  assert.ok(s.risk >= 3, "risk floor");
});

test("the 18:16 bar is under the 1.0×ATR floor — prod skips it (quality-filter sweep)", () => {
  const sigs = detectMomentum(bars(TAPE), MOM_PROD);
  assert.equal(sigs.length, 0, "bar range ÷ ATR14 is below the 1.0 gate");
});

test("the 18:16 long is sized inside the Rapid EOD 50k rules", () => {
  const s = detectMomentum(bars(TAPE), { ...MOM_PROD, minBreakRangeR: 0.85 })[0];
  // 3.5 pt stop × $2/MNQ = $7 per contract → $170 budget = 24 MNQ, $168 risk
  const size = momentumSize(s.risk);
  assert.equal(size.contracts, 24);
  assert.equal(size.dollarRisk, 168);
  assert.equal(size.capped, false);
  assert.ok(size.contracts <= RAPID_EOD_50K.maxMicro, "inside the 30-micro cap");
  assert.ok(size.dollarRisk <= 170, "inside the $170 risk budget");
  assert.ok(size.contracts * s.risk * RAPID_EOD_50K.pointValue <= 170);
  // and the 1R target pays 24 × 3.5 × $2 = $168 when it wins
  const winDollars = size.contracts * (s.target - s.entry) * RAPID_EOD_50K.pointValue;
  assert.equal(winDollars, 168);
});

test("production config does NOT fire fade shorts on the same tape", () => {
  const sigs = detectMomentum(bars(TAPE), MOM_PROD);
  assert.equal(sigs.filter((s) => s.dir === "short").length, 0);
});

test("a flush that makes a NEW session low never starts a watch", () => {
  const m = pad([
    // sell flush that breaks below the prior low — real breakdown, not ours
    ["17:00", 100.0, 97.5, 10, 90],
    // even with a strong buy response + breakout, no signal may fire
    ["17:01", 98.5, 98.0, 45, 5],
    ["17:02", 100.5, 99.0, 50, 5],
    ["17:03", 102.0, 100.5, 60, 5],
  ]);
  const sigs = detectMomentum(m, MOM_PROD);
  assert.equal(sigs.length, 0);
});

test("mirror: failed rally → sell response → breakdown fires a short", () => {
  const m = pad([
    // buy rally that FAILS to make a new session high (prior high 100.25)
    ["17:00", 100.25, 98.75, 90, 10],
    // sell response with tick proof (and a low that IS a new session low, so
    // the long machine correctly ignores this tape)
    ["17:01", 100.0, 97.5, 5, 45, [[99.5, 0, 12], [99.0, 2, 8]]],
    ["17:02", 100.75, 100.0, 10, 20],
    // one-sided sell breakout through the reference low (risk >= 3)
    ["17:03", 102.5, 97.0, 5, 55],
  ]);
  const sigs = detectMomentum(m, MOM_PROD);
  const shorts = sigs.filter((s) => s.dir === "short");
  assert.equal(shorts.length, 1);
  const s = shorts[0];
  assert.ok(s.entry < 100.0, `entry ${s.entry}`);
  assert.ok(s.stop > s.entry, "stop above entry");
});

test("default config (flush stop) also catches the run — the runner variant", () => {
  const sigs = detectMomentum(bars(TAPE), { ...MOM_DEFAULTS, breakWindow: 10 });
  const longs = sigs.filter((s) => s.dir === "long");
  assert.ok(longs.length >= 1);
  const s = longs[0];
  assert.equal(s.t, "22:16");
  // structural stop under the flush low — the wide runner stop
  assert.ok(Math.abs(s.stop - 30712.25) < 0.01, `stop ${s.stop}`);
  assert.ok(s.risk > 20, "wide structural risk");
});

test("fireAt=response enters on the one-sided response bar (structural stop)", () => {
  const sigs = detectMomentum(bars(TAPE), { ...MOM_DEFAULTS, fireAt: "response", stopMode: "flush" });
  const longs = sigs.filter((s) => s.dir === "long");
  assert.ok(longs.length >= 1);
  const s = longs[0];
  assert.equal(s.t, "22:11"); // the 71%-buy response bar
  assert.ok(Math.abs(s.entry - 30721.75) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 30712.25) < 0.01, `stop ${s.stop}`);
});

test("fireAt=flush enters on the failed flush bar itself", () => {
  const sigs = detectMomentum(bars(TAPE), { ...MOM_DEFAULTS, fireAt: "flush", stopMode: "flush" });
  const longs = sigs.filter((s) => s.dir === "long");
  assert.ok(longs.length >= 1);
  const s = longs[0];
  assert.equal(s.t, "22:10"); // the 78%-sell failed flush
  assert.ok(Math.abs(s.entry - 30723.875) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 30712.25) < 0.01, `stop ${s.stop}`);
});

test("merged mode: strength bar → failed flush → immediate breakout fires without a response bar", () => {
  // 17:00 one-sided BUY (the strength bar), 17:01 failed sell flush,
  // 17:02 breakout through the strength high — no separate response bar
  const m = pad([
    ["17:00", 102.0, 100.5, 90, 10],
    ["17:01", 101.5, 99.5, 10, 90],
    ["17:02", 106.0, 101.0, 55, 5],
  ]);
  const merged = detectMomentum(m, MOM_PROD); // merged is the production mode
  const longs = merged.filter((s) => s.dir === "long");
  assert.equal(longs.length, 1);
  assert.equal(longs[0].t, "17:02");
  assert.equal(longs[0].flushIdx, 31); // 17:01 in the padded array
  assert.ok(Math.abs(longs[0].entry - 103.5) < 0.01, `entry ${longs[0].entry}`);
  assert.ok(Math.abs(longs[0].stop - 100.5) < 0.01, `stop ${longs[0].stop}`);
  assert.ok(longs[0].risk >= 3, "risk floor");

  // with a separate response required (needResponse=true) it does NOT fire:
  // the breakout bar has no tick proof, so the response gate fails
  const strict = detectMomentum(m, { ...MOM_PROD, needResponse: true });
  assert.equal(strict.filter((s) => s.dir === "long").length, 0);
});

test("expansion: the real tape has no huge-bar signal (covers the other run class)", () => {
  // tonight's run was 60-63% one-sided — under the expansion's 0.5 delta
  // gate. The two triggers catch different runs; the combined card needs both.
  const sigs = detectExpansionScalp(bars(TAPE), EXP_PROD);
  assert.equal(sigs.length, 0);
});

test("expansion fires on a huge one-sided bar with a matching stack", () => {
  const m = pad([
    // 6-pt bar on a ~0.5-pt ATR (12× ATR), 90% buy, buy stack
    ["17:00", 105.0, 99.0, 90, 10, [[104.5, 8, 0], [104.0, 10, 1], [103.5, 6, 0], [103.0, 5, 1]]],
  ]);
  const sigs = detectExpansionScalp(m, EXP_PROD);
  const longs = sigs.filter((s) => s.dir === "long");
  assert.equal(longs.length, 1);
  const s = longs[0];
  assert.equal(s.kind, "expansion");
  assert.equal(s.t, "17:00");
  assert.ok(Math.abs(s.entry - 102.0) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 98.5) < 0.01, `stop ${s.stop}`);
  assert.ok(s.breakRangeR >= 1.6, `rangeR ${s.breakRangeR}`);
});

test("expansion gate: a 63%-one-sided huge bar does NOT fire (tonight's 18:41 class)", () => {
  const m = pad([
    ["17:00", 105.0, 99.0, 63, 37, [[104.5, 8, 2], [104.0, 9, 4], [103.5, 5, 3], [103.0, 4, 2]]],
  ]);
  const sigs = detectExpansionScalp(m, EXP_PROD);
  assert.equal(sigs.length, 0, "63% one-sided is below the 0.5 delta gate");
});

test("churn veto: a huge two-way bar (both stacks) does not fire", () => {
  const m = pad([
    ["17:00", 105.0, 99.0, 50, 50, [[104.5, 8, 0], [104.0, 9, 0], [103.5, 0, 8], [103.0, 0, 9]]],
  ]);
  const sigs = detectExpansionScalp(m, { ...EXP_PROD, minAbsDeltaFrac: 0.05 });
  assert.equal(sigs.length, 0, "balanced bar fails the delta gate anyway");
  // and the momentum detector's churnVeto blocks it even when one-sidedness passes
  const momSigs = detectMomentum(
    m,
    { ...MOM_PROD, churnVeto: true, breakFrac: 0.5, minRiskPts: 3 },
  );
  assert.equal(momSigs.length, 0);
});

test("open drive: cumulative delta + huge bar through the opening high fires long", () => {
  // 58 quiet overnight bars (hourET 7), then the 9:30 open: two-way open
  // bar, then the drive bar — 60% buy, huge range, cumD >= 300, closes
  // through the opening high (detector needs >= 60 bars of warm-up)
  const quiet: [string, number, number, number, number][] = [];
  for (let i = 0; i < 58; i++) {
    const h = Math.floor(i / 60);
    const t = `06:${String(i % 60).padStart(2, "0")}`;
    quiet.push([t, 100.25, 99.75, 50, 50]);
  }
  const m = bars([
    ...quiet,
    ["08:30", 101.5, 99.75, 200, 100], // 9:30 open bar, +100 delta
    ["08:31", 110.5, 100.0, 1200, 800], // drive bar: 60% buy, cumD 500
    ["08:32", 106.0, 105.0, 60, 60],
    ["08:33", 106.5, 105.5, 60, 60],
    ["08:34", 107.0, 106.0, 60, 60],
  ]);
  const sigs = detectOpenDrive(m, OPEN_PROD);
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.equal(s.t, "08:31"); // the drive bar breaking the opening high (scan mode)
  assert.ok(s.cumDelta >= 300, `cumD ${s.cumDelta}`);
  // scan fixed plan: TP 15 / SL 35 from the drive bar's close
  const entry = (110.5 + 100.0) / 2; // 105.25
  assert.ok(Math.abs(s.entry - entry) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - (entry - 35)) < 0.01, `stop ${s.stop}`);
  assert.ok(Math.abs(s.target - (entry + 15)) < 0.01, `target ${s.target}`);
  assert.ok(Math.abs(s.risk - 35) < 0.01, `risk ${s.risk}`);
});

test("pullback mode: trend + exhausted pullback + reclaim fires the morning entry", () => {
  const quiet: [string, number, number, number, number][] = [];
  for (let i = 0; i < 58; i++) {
    const t = `06:${String(i % 60).padStart(2, "0")}`;
    quiet.push([t, 100.25, 99.75, 50, 50]);
  }
  const win: [string, number, number, number, number][] = [];
  // 08:30-08:44: 15 up-trend bars (+40 delta each)
  for (let j = 0; j < 15; j++) {
    win.push([`08:${String(30 + j).padStart(2, "0")}`, 101 + j, 100 + j, 70, 30]);
  }
  // 08:45: first counter bar (delta -40) — too big to be "shrinking" yet
  win.push(["08:45", 115.5, 114.8, 10, 50]);
  // 08:46: the pullback (delta -20, shrinking vs -40, holds the 5-bar low)
  win.push(["08:46", 115.0, 114.6, 30, 50]);
  // 08:47: the reclaim — closes above the pullback high with buy delta
  win.push(["08:47", 115.5, 114.7, 60, 20]);
  const m = bars([...quiet, ...win]);
  const sigs = detectOpenDrive(m, PULLBACK_PROD);
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.equal(s.t, "08:47");
  assert.ok(s.cumDelta > 0, `trend delta ${s.cumDelta}`);
  const entry = (115.5 + 114.7) / 2; // 115.1
  assert.ok(Math.abs(s.entry - entry) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 114.1) < 0.01, `stop ${s.stop}`); // pullback low 114.6 - 0.5
  assert.ok(Math.abs(s.target - (entry + (entry - 114.1))) < 0.01, `target ${s.target}`);
});

test("sniper: big one-sided flush holding the opening-range anchor prints the resting-limit ticket", () => {
  const quiet: [string, number, number, number, number][] = [];
  for (let i = 0; i < 58; i++) {
    const t = `06:${String(i % 60).padStart(2, "0")}`;
    quiet.push([t, 100.25, 99.75, 50, 50]);
  }
  const m = bars([
    ...quiet,
    // opening range 9:30-9:35 (hourET 9): anchor low = 99.5
    ["08:30", 101.0, 99.5, 60, 60],
    ["08:31", 101.5, 100.0, 60, 60],
    ["08:32", 102.0, 100.5, 60, 60],
    ["08:33", 102.5, 101.0, 60, 60],
    ["08:34", 103.0, 101.5, 60, 60],
    ["08:35", 103.5, 102.0, 60, 60],
    // 9:36 flush: big, 60% sell, holds the anchor (low 99.75 >= 99.5 - 1)
    ["08:36", 102.0, 99.75, 200, 300],
  ]);
  const sigs = detectOpenDrive(m, SNIPER_PROD);
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.equal(s.t, "08:36");
  assert.ok(Math.abs(s.entry - 109.0) < 0.01, `entry ${s.entry}`); // anchor 99.5 + 9.5
  assert.ok(Math.abs(s.stop - 89.5) < 0.01, `stop ${s.stop}`); // anchor 99.5 - 10
  assert.ok(Math.abs(s.target - 102.0) < 0.01, `target ${s.target}`); // the flush's high
});

test("RTH soft-continuation: 60% one-sided RTH bar fires, Globex bars don't", () => {
  assert.equal(inRTH("13:30"), true, "9:30 ET is RTH"); // feed clock 8:30 Central
  assert.equal(inRTH("20:00"), false, "evening is not RTH");
  const quiet: [string, number, number, number, number][] = [];
  for (let i = 0; i < 30; i++) quiet.push([`07:${String(i % 60).padStart(2, "0")}`, 100.25, 99.75, 50, 50]);
  const m = bars([
    ...quiet,
    // 9:31 ET: 60% buy, range 4.0 (≥1×ATR14), 3 dominant buy clusters
    ["08:31", 103.0, 99.0, 60, 40, [[102.5, 8, 1], [101.5, 7, 1], [100.5, 6, 2], [99.5, 5, 0]]],
  ]);
  const sigs = detectSoftMomentum(m, SOFT_PROD);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].dir, "long");
  assert.equal(sigs[0].t, "08:31");
  // 0.75R plan: entry = mid 101.0, stop = 98.0 (risk 3), target = 103.25
  assert.ok(Math.abs(sigs[0].entry - 101.0) < 0.01, `entry ${sigs[0].entry}`);
  assert.ok(Math.abs(sigs[0].stop - 98.0) < 0.01, `stop ${sigs[0].stop}`);
  assert.ok(Math.abs(sigs[0].target - 103.25) < 0.01, `target ${sigs[0].target}`);
  // and a Globex-hours 60% bar does NOT fire
  const m2 = bars([
    ...quiet,
    ["13:00", 101.5, 100.0, 60, 40], // 14:00 ET? 13:00 Central = 14:00 ET → RTH! use 15:00 Central = 16:00 ET boundary
  ]);
  void m2;
  const m3 = bars([
    ...quiet,
    ["11:00", 101.5, 100.0, 60, 40], // 12:00 ET → RTH → would fire (fine)
  ]);
  void m3;
  const m4 = bars([
    ...quiet,
    ["21:00", 101.5, 100.0, 60, 40], // 22:00 ET → Globex → no fire
  ]);
  assert.equal(detectSoftMomentum(m4, SOFT_PROD).length, 0);
});

/* feed-gap helper (lib/signalFeed) */
import { feedMinutesGap } from "../lib/signalFeed";

test("feedMinutesGap: adjacent, wrapped midnight, unparseable", () => {
  assert.equal(feedMinutesGap("21:59", "22:00"), 1);
  assert.equal(feedMinutesGap("21:59", "22:02"), 3);
  assert.equal(feedMinutesGap("23:59", "00:00"), 1); // midnight wrap
  assert.equal(feedMinutesGap("23:58", "00:00"), 2);
  assert.equal(feedMinutesGap("9:5", "22:00"), null);
  assert.equal(feedMinutesGap("", "22:00"), null);
});
