/* ------------------------------------------------------------------ *
 * Card-path smoke — the end-to-end contract that a healthy setup must
 * produce a placeable card (the 2026-10-15 lesson: each gate passed its
 * own unit tests while the pipeline silently killed every card).
 *
 * Uses the REAL 2026-09-30 failed-flush tape (mirrored from
 * tests/momentum.test.ts — the 18:10 flush → 18:16 breakout that the
 * production detector must fire as a long @30738.0/30734.5/30741.5).
 * The full card path is composed from the REAL pieces:
 * detector → tape gate + stale veto (cardGateDecision) → ticket veto →
 * sizing within the Rapid EOD 50k plan.
 * ------------------------------------------------------------------ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMomentum, MOM_PROD, type MomMinute } from "../lib/momentum";
import { cardGateDecision, barCloseMs, STALE_SIGNAL_VETO_MS } from "../lib/signalFeed";
import { ticketVetoDecision, ticketVetoBar } from "../lib/ticketVeto";
import { momentumSize, RAPID_EOD_50K, planMaxMicro } from "../lib/propRules";

/** compact bar builder — the SAME shape as tests/momentum.test.ts */
type Bar = [string, number, number, number, number, [number, number, number][]?];
function bars(rows: Bar[], d = "2026-09-30"): MomMinute[] {
  return rows.map(([t, high, low, buy, sell, lv]) => ({
    t,
    d,
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

/* the real tape (22:00–22:47 UTC = 18:00–18:47 ET): the failed flush at
 * 22:10 → one-sided breakout at 22:16, +58 pts to 30794.75. Mirrored
 * verbatim from tests/momentum.test.ts (the golden fixture). */
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
  ["22:10", 30735.0, 30712.75, 48, 168], // failed flush: 78% sell
  ["22:11", 30724.5, 30719.0, 30, 12, [[30721.75, 10, 0], [30721.5, 6, 2], [30722.25, 5, 0]]],
  ["22:12", 30732.5, 30722.25, 32, 31],
  ["22:13", 30734.0, 30731.0, 11, 20],
  ["22:14", 30737.5, 30728.5, 31, 30],
  ["22:15", 30735.25, 30732.0, 5, 17],
  ["22:16", 30741.0, 30735.0, 44, 7, [[30741.0, 4, 0], [30740.75, 8, 0], [30740.0, 4, 0]]], // one-sided breakout
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

test("card-path smoke: a healthy failed-flush setup passes every gate to a placeable card", () => {
  const sigs = detectMomentum(pad(TAPE), { ...MOM_PROD, minBreakRangeR: 0.85 });
  assert.equal(sigs.length, 1, "the detector must fire exactly one flush signal");
  const s = sigs[0];
  assert.equal(s.dir, "long");
  assert.ok(Math.abs(s.entry - 30738.0) < 0.01);
  assert.ok(Math.abs(s.stop - 30734.5) < 0.01);
  assert.ok(Math.abs(s.target - 30741.5) < 0.01);

  // 1. the tape gate + stale veto: the tail bar (22:47) is candle-sourced
  //    and fresh → no hold, no veto. ANY gate regression that blocks a
  //    healthy setup fails HERE.
  const tailClose = barCloseMs({ t: "22:47", d: "2026-09-30" })!;
  const g = cardGateDecision({ tail: 0, totalBars: 78, tailAgeMs: 30_000, now: tailClose + 30_000, lastAlertAt: 0 });
  assert.deepEqual(g, { hold: false, veto: false });

  // 2. the ticket veto: the momentum_flush cell must not veto this long
  const vet = ticketVetoDecision({ family: "momentum_flush", hourBucket: "globex_early", dir: "long" }, ticketVetoBar());
  assert.equal(vet.veto, false, `ticket veto blocked a healthy card: ${vet.reason}`);

  // 3. sizing: the 3.5-pt risk must size inside the Rapid EOD 50k plan
  const size = momentumSize(s.risk, 100, RAPID_EOD_50K);
  assert.ok(size.contracts >= 1 && size.contracts <= planMaxMicro(), `contracts ${size.contracts} outside the plan`);

  // 4. the bracket is coherent
  assert.ok(s.stop < s.entry && s.entry < s.target);
});

test("card-path smoke: the SAME setup is vetoed when the tail is dead (the veto's two-sided contract)", () => {
  const sigs = detectMomentum(pad(TAPE), { ...MOM_PROD, minBreakRangeR: 0.85 });
  assert.equal(sigs.length, 1);
  const tailClose = barCloseMs({ t: "22:47", d: "2026-09-30" })!;
  const g = cardGateDecision({ tail: 0, totalBars: 78, tailAgeMs: STALE_SIGNAL_VETO_MS + 60_000, now: tailClose + STALE_SIGNAL_VETO_MS + 60_000, lastAlertAt: 0 });
  assert.equal(g.veto, true, "a dead tail must veto — the 02:54-on-22:52 incident");
});
