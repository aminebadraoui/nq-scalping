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
import { detectMomentum, MOM_PROD, MOM_DEFAULTS, type MomMinute } from "../lib/momentum";
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
  const sigs = detectMomentum(bars(TAPE), MOM_PROD);
  assert.equal(sigs.length, 1, "exactly one signal expected");
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.equal(s.t, "22:16"); // 18:16 ET
  assert.equal(s.flushIdx, 10); // 22:10 flush
  assert.equal(s.respIdx, 11); // 22:11 response
  assert.equal(s.breakIdx, 16); // 22:16 breakout
  assert.ok(Math.abs(s.entry - 30738.0) < 0.01, `entry ${s.entry}`);
  assert.ok(Math.abs(s.stop - 30734.5) < 0.01, `stop ${s.stop}`);
  assert.ok(s.risk >= 2, "risk floor");
});

test("the 18:16 long is sized inside the Rapid EOD 50k rules", () => {
  const s = detectMomentum(bars(TAPE), MOM_PROD)[0];
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
    // sell response with tick proof
    ["17:01", 100.0, 98.75, 5, 45, [[99.5, 0, 12], [99.0, 2, 8]]],
    ["17:02", 100.75, 100.0, 10, 20],
    // one-sided sell breakout through the reference low (risk >= 2)
    ["17:03", 101.5, 97.5, 5, 55],
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
