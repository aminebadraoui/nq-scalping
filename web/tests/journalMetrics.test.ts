import { test } from "node:test";
import assert from "node:assert/strict";
import { streakTable, drawdownTable, hourMatrix, hourTable, type MetricTrade } from "../lib/journalMetrics";

const t = (ts: number, family: string, hour: string, result: string, net: number): MetricTrade => ({
  ts,
  day: `2026-10-0${1 + (ts % 9)}`,
  family,
  hourBucket: hour,
  result,
  netUsd: net,
});

test("streakTable: consecutive runs, flats ignored, per-family", () => {
  const trades = [
    t(1, "session_continuation", "rth", "win", 100),
    t(2, "session_continuation", "rth", "win", 90),
    t(3, "session_continuation", "rth", "flat", 0),
    t(4, "session_continuation", "rth", "loss", -80),
    t(5, "session_continuation", "rth", "win", 50),
    t(6, "failed_flush_breakout", "globex_core", "loss", -100),
    t(7, "failed_flush_breakout", "globex_core", "loss", -120),
    t(8, "failed_flush_breakout", "globex_core", "loss", -130),
    t(9, "failed_flush_breakout", "globex_core", "win", 200),
  ];
  const rows = streakTable(trades);
  const rth = rows.find((r) => r.family === "session_continuation")!;
  const mom = rows.find((r) => r.family === "failed_flush_breakout")!;
  assert.equal(rth.maxWin, 2, "RTH max win streak spans the flat");
  assert.equal(rth.maxLoss, 1);
  assert.equal(rth.curWin, 1, "current run is the final win");
  assert.equal(rth.curLoss, 0);
  assert.equal(mom.maxLoss, 3, "flush opens with 3 straight losses");
  assert.equal(mom.maxWin, 1);
  assert.equal(mom.curWin, 1);
  assert.equal(mom.n, 4);
});

test("drawdownTable: running-net trough from peak, worst day", () => {
  const trades = [
    t(1, "session_continuation", "rth", "win", 200),
    t(2, "session_continuation", "rth", "win", 100), // peak 300
    t(3, "session_continuation", "rth", "loss", -250), // 50 → dd -250
    t(4, "session_continuation", "rth", "loss", -100), // -50 → dd -350
    t(5, "session_continuation", "rth", "win", 400), // 350 → new peak, dd stays -350
  ].map((x) => ({ ...x, day: x.ts <= 4 ? "2026-10-01" : "2026-10-02" }));
  const rows = drawdownTable(trades);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].maxDdUsd, -350);
  assert.equal(rows[0].ddPct, Math.round((-350 / 300) * 10000) / 100, "dd% is vs the 300 peak at the trough moment");
  assert.equal(rows[0].worstDayUsd, -50, "day 1 nets -50 (200+100-250-100)");
  assert.equal(rows[0].worstDay, "2026-10-01");
});

test("drawdownTable: never-positive strategy has null ddPct", () => {
  const rows = drawdownTable([t(1, "other", "rth", "loss", -50)]);
  assert.equal(rows[0].ddPct, null);
  assert.equal(rows[0].maxDdUsd, -50);
});

test("hourMatrix: one cell per family×hour with wr", () => {
  const trades = [
    t(1, "session_continuation", "rth", "win", 100),
    t(2, "session_continuation", "rth", "loss", -50),
    t(3, "session_continuation", "globex_late", "win", 60),
    t(4, "failed_flush_breakout", "rth", "loss", -90),
  ];
  const cells = hourMatrix(trades);
  assert.equal(cells.length, 3);
  const rthRth = cells.find((c) => c.family === "session_continuation" && c.hour === "rth")!;
  assert.equal(rthRth.n, 2);
  assert.equal(rthRth.wr, 50);
  assert.equal(rthRth.netUsd, 50);
  const empty = cells.find((c) => c.family === "failed_flush_breakout" && c.hour === "globex_core");
  assert.equal(empty, undefined, "no empty cells are fabricated");
});

test("hourTable: sorted by net, exp per trade", () => {
  const trades = [
    t(1, "session_continuation", "rth", "win", 200),
    t(2, "session_continuation", "globex_late", "loss", -100),
    t(3, "session_continuation", "globex_late", "win", 40),
  ];
  const rows = hourTable(trades);
  assert.equal(rows[0].hour, "rth");
  assert.equal(rows[0].netUsd, 200);
  assert.equal(rows[0].expUsd, 200);
  const late = rows.find((r) => r.hour === "globex_late")!;
  assert.equal(late.n, 2);
  assert.equal(late.wr, 50);
  assert.equal(late.expUsd, -30);
});
