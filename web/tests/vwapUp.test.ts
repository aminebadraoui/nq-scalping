/* Unit tests for the VWAP-UP detector (lib/vwapUp.ts): arming window,
 * the trend condition, the first-touch one-trade-per-day rule, the
 * bracket, and fixed-risk sizing. */
import { test } from "node:test";
import assert from "node:assert";
import { vwapUpState, vwapUpContracts, sessionVwap, VWAPUP_PROD, type VwapBar } from "../lib/vwapUp";

const D = "2026-10-27";
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** a steady uptrend from 08:30 CT: each bar 1 pt higher, 4-pt range */
function uptrend(nBars: number, start = 20000): VwapBar[] {
  const out: VwapBar[] = [];
  for (let k = 0; k < nBars; k++) {
    const mid = start + k;
    out.push({ t: hhmm(8 * 60 + 30 + k), d: D, o: mid - 1, c: mid + 1, high: mid + 2, low: mid - 2, buy: 100, sell: 100 });
  }
  return out;
}

test("sessionVwap: volume-weighted typical price", () => {
  const vw = sessionVwap([
    { t: "08:30", d: D, o: 0, c: 10, high: 12, low: 8, buy: 1, sell: 0 },
    { t: "08:31", d: D, o: 0, c: 20, high: 22, low: 18, buy: 3, sell: 0 },
  ]);
  assert.equal(vw[0], 10);
  assert.equal(vw[1], (10 * 1 + 20 * 3) / 4);
});

test("vwapUpState: no arm before 09:30 CT (10:30 ET)", () => {
  const st = vwapUpState(uptrend(50)); // last completed bar 09:19 CT
  assert.equal(st.arm, null);
  assert.equal(st.done, false);
});

test("vwapUpState: arms a buy limit at VWAP (floored to tick) with the 25/50 bracket", () => {
  const bars = uptrend(70); // upcoming bar 09:40 CT, 70 bars above a rising VWAP
  const st = vwapUpState(bars);
  assert.ok(st.arm);
  assert.equal(st.arm!.armT, "09:40");
  const vw = sessionVwap(bars).at(-1)!;
  assert.ok(st.arm!.level <= vw && vw - st.arm!.level < 0.25);
  assert.equal(st.arm!.stop, st.arm!.level - VWAPUP_PROD.stopPts);
  assert.equal(st.arm!.target, st.arm!.level + VWAPUP_PROD.targetPts);
});

test("vwapUpState: a bar dipping to VWAP breaks the trend → no arm", () => {
  const bars = uptrend(70);
  const vw = sessionVwap(bars);
  bars[60] = { ...bars[60], low: vw[60] - 1 };
  assert.equal(vwapUpState(bars).arm, null);
});

test("vwapUpState: the first armed touch spends the day (filled or not)", () => {
  const bars = uptrend(70);
  const st0 = vwapUpState(bars);
  assert.ok(st0.arm);
  // the upcoming bar trades down through the armed level
  bars.push({ t: st0.arm!.armT, d: D, o: st0.arm!.level + 3, c: st0.arm!.level + 1, high: st0.arm!.level + 4, low: st0.arm!.level - 1, buy: 100, sell: 100 });
  // ...and the trend resumes for another hour
  for (let k = 0; k < 60; k++) {
    const last = bars.at(-1)!;
    const mid = last.c + 3;
    bars.push({ t: hhmm(8 * 60 + 30 + bars.length), d: D, o: mid - 1, c: mid + 1, high: mid + 2, low: mid - 1, buy: 100, sell: 100 });
  }
  const st = vwapUpState(bars);
  assert.equal(st.done, true);
  assert.equal(st.arm, null);
});

test("vwapUpState: no arm at/after 14:00 CT (15:00 ET)", () => {
  const bars = uptrend(14 * 60 - (8 * 60 + 30)); // last completed 13:59 → upcoming 14:00
  assert.equal(vwapUpState(bars).arm, null);
});

test("vwapUpState: a downtrend never arms (long only)", () => {
  const bars = uptrend(70).map((b, k) => ({ ...b, high: 30000 - k + 2, low: 30000 - k - 2, c: 30000 - k - 1, o: 30000 - k + 1 }));
  assert.equal(vwapUpState(bars).arm, null);
});

test("vwapUpContracts: fixed $100 risk on a 25-pt stop = 2 MNQ, never 0", () => {
  assert.equal(vwapUpContracts(100), 2);
  assert.equal(vwapUpContracts(40), 1);
  assert.equal(vwapUpContracts(250), 5);
});
