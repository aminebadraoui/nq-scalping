/* Unit tests for the execution watcher's protection layer
 * (lib/execWatch.ts): the emergency re-arm stop anchoring and the
 * working-stop classifier — the pure decision rules behind the
 * naked-position repair from the 2026-10-08 incident. */
import { test } from "node:test";
import assert from "node:assert";
import { stopCoversPosition, classifyExitFill, pickExitFill, EXIT_SLIP_WINDOW_MS } from "../lib/execWatch";
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

/* ---- stop-slippage classifier (2026-10-08 −$1,056 event) ---- */

test("classifyExitFill: short exited far above the stop → stop_slipped", () => {
  // the 12:16 card: stop 31190.56, exit 31224.00 → 33.4 pts beyond
  assert.equal(classifyExitFill({ dir: "short", stop: 31190.56, target: 31179.41 }, 31224.0), "stop_slipped");
});

test("classifyExitFill: long exited far below the stop → stop_slipped", () => {
  assert.equal(classifyExitFill({ dir: "long", stop: 31238.44, target: 31261.84 }, 31235.0), "stop_slipped");
});

test("classifyExitFill: exit near the target → target (normal)", () => {
  assert.equal(classifyExitFill({ dir: "short", stop: 31238.76, target: 31216.05 }, 31213.75), "target");
  assert.equal(classifyExitFill({ dir: "long", stop: 31238.44, target: 31261.84 }, 31262.5), "target");
});

test("classifyExitFill: stop-out near the trigger → null (intended outcome)", () => {
  assert.equal(classifyExitFill({ dir: "short", stop: 31238.76, target: 31216.05 }, 31239.0), null);
});

/* ---- exit-fill window (2026-10-12 phantom-slip recurrence) ---- */

test("pickExitFill: last opposite-side fill inside the window wins", () => {
  const now = 1_000_000;
  const older = { ts: now - 5_000, action: "Sell", qty: 7, price: 100 };
  const newer = { ts: now - 2_000, action: "Sell", qty: 7, price: 101 };
  assert.deepEqual(pickExitFill([older, newer], "long", now), newer);
});

test("pickExitFill: stale history outside the window is ignored (the Friday-31185.25 shape)", () => {
  // 2026-10-12: a flat transition on a ~30885 tape was compared against a
  // Friday fill at 31185.25 → "275.6/308.3 pts slipped" phantom alarms.
  const now = Date.now();
  const fills = [{ ts: now - 3 * 24 * 3600_000, action: "Sell", qty: 7, price: 31185.25 }];
  assert.equal(pickExitFill(fills, "long", now), null);
});

test("pickExitFill: wrong side, non-finite ts, or empty fills → null", () => {
  const now = Date.now();
  assert.equal(pickExitFill([{ ts: now - 1_000, action: "Buy", qty: 7, price: 100 }], "long", now), null);
  assert.equal(pickExitFill([{ ts: Number.NaN, action: "Sell", qty: 7, price: 100 }], "long", now), null);
  assert.equal(pickExitFill([], "short", now), null);
});

test("pickExitFill: default window is the shipped EXIT_SLIP_WINDOW_MS (15 min)", () => {
  const now = Date.now();
  const inside = { ts: now - EXIT_SLIP_WINDOW_MS, action: "Sell", qty: 7, price: 100 };
  const outside = { ts: now - EXIT_SLIP_WINDOW_MS - 1, action: "Sell", qty: 7, price: 100 };
  assert.deepEqual(pickExitFill([inside], "long", now), inside);
  assert.equal(pickExitFill([outside], "long", now), null);
});

/* ---- broker verification under vendor pacing (2026-10-12) ---- */

test("verifyAbsent rides out broker_rate_limited on both reads and confirms clean", async () => {
  const { __resetCtAccountForTest } = await import("../lib/ctAccount");
  const { verifyAbsent } = await import("../lib/execWatch");
  __resetCtAccountForTest({ backoffBaseMs: 1 });
  process.env.CROSSTRADE_KEY = "test-key";
  process.env.CROSSTRADE_ACCOUNT = "MFFUEVREOD1234";
  let calls = 0;
  const jsonText = (payload: unknown, status = 200): typeof fetch =>
    (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      }) as unknown as Response) as unknown as typeof fetch;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    if (calls <= 2) return jsonText({ success: false, error: "broker_rate_limited", detail: "pacing" })(input, init);
    if (calls === 3) return jsonText({ success: true, data: [] })(input, init); // orders
    return jsonText({ success: true, data: [] })(input, init); // positions
  };
  const v = await verifyAbsent({ fetchFn });
  assert.equal(calls, 4); // 2 pacing retries on orders, then the two clean reads
  assert.deepEqual(v, { clean: true, reason: "no working order, no position — verified absent" });
});

/* ---- expiry-cancel verdict (already-gone broker-side is not a panic) ---- */

test("expiryCancelVerdict: ok cancel is expired-clean", async () => {
  const { expiryCancelVerdict } = await import("../lib/execWatch");
  const v = expiryCancelVerdict(true, "cancelled", { ok: true, orders: [] }, "ord-1");
  assert.deepEqual(v, { outcome: "limit_expired", reason: "cancelled" });
});

test("expiryCancelVerdict: failed cancel + id absent from a readable book is expired-clean", async () => {
  const { expiryCancelVerdict } = await import("../lib/execWatch");
  const v = expiryCancelVerdict(
    false,
    "cancel rejected: order not found",
    { ok: true, orders: [{ id: "other-2" }] },
    "ord-1",
  );
  assert.equal(v.outcome, "limit_expired");
  assert.match(v.reason, /already gone broker-side/);
});

test("expiryCancelVerdict: still-present order or unreadable book stays a failure (fail closed)", async () => {
  const { expiryCancelVerdict } = await import("../lib/execWatch");
  assert.equal(
    expiryCancelVerdict(false, "cancel rejected", { ok: true, orders: [{ orderId: "ord-1" }] }, "ord-1").outcome,
    "limit_cancel_failed",
  );
  assert.equal(
    expiryCancelVerdict(false, "cancel rejected", { ok: false, orders: [] }, "ord-1").outcome,
    "limit_cancel_failed",
  );
  assert.equal(
    expiryCancelVerdict(false, "no order id — cannot cancel", { ok: true, orders: [] }, "").outcome,
    "limit_cancel_failed",
  );
});
