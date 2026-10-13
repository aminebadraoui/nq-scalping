/* Unit tests for the CrossTrade WebSocket stream (lib/ctStream.ts):
 * the pnlUpdate frame parser — the flatten arm's sub-second trigger.
 * (The WebSocket lifecycle is exercised live; only the pure parser is
 * unit-tested, same convention as the rest of the module.) */
import { test } from "node:test";
import assert from "node:assert";
import { parsePnlUpdate } from "../lib/ctStream";

const FRAME = {
  type: "pnlUpdate",
  origin: "tradovate",
  epoch: 1791849571723,
  accounts: [
    {
      name: "MFFUSFREOD706880008",
      stats: { pnl: 50.0 },
      pnl: { unrealized: -260.0 },
      netLiquidation: 321.1,
      metadata: { openPositions: 1 },
      positions: [],
      orders: [],
    },
  ],
  seq: 1,
};

test("parses the captured live pnlUpdate frame into account rows", () => {
  const rows = parsePnlUpdate(FRAME);
  assert.ok(rows);
  assert.equal(rows!.length, 1);
  assert.equal(rows![0].name, "MFFUSFREOD706880008");
  assert.equal(rows![0].realized, 50);
  assert.equal(rows![0].openPnl, -260);
  assert.equal(rows![0].equity, 321.1);
});

test("non-tradovate or non-pnl frames are ignored", () => {
  assert.equal(parsePnlUpdate({ ...FRAME, origin: "other" }), null);
  assert.equal(parsePnlUpdate({ ...FRAME, type: "orderUpdate" }), null);
  assert.equal(parsePnlUpdate(null), null);
  assert.equal(parsePnlUpdate("garbage"), null);
});

test("accounts with missing/non-numeric fields are dropped", () => {
  const bad = {
    type: "pnlUpdate",
    origin: "tradovate",
    accounts: [
      { name: "ok", stats: { pnl: 1 }, pnl: { unrealized: 2 }, netLiquidation: 3 },
      { name: "missing-open", stats: { pnl: 1 }, netLiquidation: 3 },
      { name: "bad-equity", stats: { pnl: 1 }, pnl: { unrealized: 2 }, netLiquidation: "n/a" },
      { name: 42, stats: { pnl: 1 }, pnl: { unrealized: 2 }, netLiquidation: 3 },
    ],
  };
  const rows = parsePnlUpdate(bad);
  assert.ok(rows);
  assert.equal(rows!.length, 1);
  assert.equal(rows![0].name, "ok");
});

test("a pnlUpdate without accounts is null", () => {
  assert.equal(parsePnlUpdate({ type: "pnlUpdate", origin: "tradovate" }), null);
});
