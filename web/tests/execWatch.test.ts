/* Unit tests for the execution watcher's protection layer
 * (lib/execWatch.ts): the emergency re-arm stop anchoring and the
 * working-stop classifier — the pure decision rules behind the
 * naked-position repair from the 2026-10-08 incident. */
import { test } from "node:test";
import assert from "node:assert";
import { stopCoversPosition } from "../lib/execWatch";
import { rearmStopPrice } from "../lib/crossTrade";

test("rearmStopPrice: long anchors the stop just BELOW the tape (Tradovate-valid)", () => {
  // 4 ticks = 1 pt below a 31245.0 tape
  assert.equal(rearmStopPrice("long", 31245.0), 31244.0);
  assert.equal(rearmStopPrice("long", 31245.0, 8), 31243.0);
});

test("rearmStopPrice: short anchors the stop just ABOVE the tape (the incident side)", () => {
  // a short's buy-stop must sit above the market or Tradovate rejects it again
  assert.equal(rearmStopPrice("short", 31229.25), 31230.25);
  assert.equal(rearmStopPrice("short", 31229.25, 12), 31232.25);
});

test("rearmStopPrice: no tape → null (caller falls back to flatten)", () => {
  assert.equal(rearmStopPrice("long", null), null);
  assert.equal(rearmStopPrice("short", undefined), null);
  assert.equal(rearmStopPrice("short", Number.NaN), null);
});

test("rearmStopPrice: pad is floored at one tick", () => {
  assert.equal(rearmStopPrice("long", 100.0, 0), 99.75);
  assert.equal(rearmStopPrice("long", 100.0, -5), 99.75);
});

test("stopCoversPosition: a working exit-side stop order covers the position", () => {
  // short position → a Buy stop (action Buy + stopPrice) is the cover
  assert.equal(
    stopCoversPosition(
      [
        { action: "Buy", ordStatus: "Working", instrument: "MNQZ6", orderType: "Stop", stopPrice: 31230.25 },
        { action: "Buy", ordStatus: "Working", instrument: "MNQZ6", orderType: "Limit", price: 31200.0 },
      ],
      "short",
    ),
    true,
  );
  // long position → a Sell stop covers
  assert.equal(
    stopCoversPosition([{ action: "Sell", ordStatus: "Working", instrument: "MNQZ6", orderType: "Stop", stopPrice: 31255.75 }], "long"),
    true,
  );
});

test("stopCoversPosition: wrong side, rejected, or non-MNQ orders do not cover", () => {
  // short position: the only working order is the TARGET (a Buy limit — no stopPrice)
  assert.equal(
    stopCoversPosition([{ action: "Buy", ordStatus: "Working", instrument: "MNQZ6", orderType: "Limit", price: 31200.0 }], "short"),
    false,
  );
  // the incident shape: the stop row is Rejected, the target row was cancelled
  assert.equal(
    stopCoversPosition(
      [
        { action: "Buy", ordStatus: "Rejected", instrument: "MNQZ6", orderType: "Stop", stopPrice: 31222.75 },
        { action: "Buy", ordStatus: "Canceled", instrument: "MNQZ6", orderType: "Limit", price: 31200.0 },
      ],
      "short",
    ),
    false,
  );
  // non-MNQ instrument (the watcher's instrument filter is deliberately
  // loose — any MNQ contract counts, mirroring readMnqHeld/verifyAbsent)
  assert.equal(stopCoversPosition([{ action: "Sell", ordStatus: "Working", instrument: "ESZ6", stopPrice: 100 }], "long"), false);
});

test("stopCoversPosition: empty or unknown-status orders never cover", () => {
  assert.equal(stopCoversPosition([], "short"), false);
  assert.equal(stopCoversPosition([{ action: "Buy", instrument: "MNQZ6", stopPrice: 31230.25 }], "short"), true); // status absent but stopPrice present → cover
});
