/* Unit tests for the execution watcher's protection layer
 * (lib/execWatch.ts): the emergency re-arm stop anchoring and the
 * working-stop classifier — the pure decision rules behind the
 * naked-position repair from the 2026-10-08 incident. */
import { test } from "node:test";
import assert from "node:assert";
import { stopCoversPosition, classifyExitFill, pickExitFill, EXIT_SLIP_WINDOW_MS, findMatchingFill } from "../lib/execWatch";
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

/* ---- verified-resend machinery end-to-end (2026-10-12 diagnostic) ---- */

test("checkExpectations: an unfilled card reaches broker verification and logs it", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { __resetCtAccountForTest } = await import("../lib/ctAccount");
  const { registerExpectation, checkExpectations } = await import("../lib/execWatch");
  __resetCtAccountForTest({ backoffBaseMs: 1 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-watch-"));
  process.env.GC_DATA_DIR = tmp;
  delete process.env.DATABASE_URL; // never touch Neon from a unit test
  process.env.EXECUTE_LIVE = "1";
  process.env.CROSSTRADE_KEY = "test-key";
  process.env.CROSSTRADE_ACCOUNT = "MFFUEVREOD1234";
  process.env.TELEGRAM_BOT_TOKEN = "1:fake";
  process.env.TELEGRAM_CHAT_ID = "1";
  // a window-open timestamp: Sunday 19:30 ET (the daily halt would otherwise skip)
  const nowMs = Date.parse("2026-10-11T19:30:00-04:00");
  let ctCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("crosstrade.io")) {
      ctCalls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: [] }),
        json: async () => ({ success: true, data: [] }),
      } as unknown as Response;
    }
    // the Telegram alert attempt — offline-safe failure
    return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    registerExpectation({
      key: "rth|2026-10-11|short|19:28",
      ts: nowMs - 120_000,
      label: "rth short 19:28",
      intent: { symbol: "NQ", dir: "short", contracts: 8, entry: 20000, stop: 20005, target: 19980, timeET: "19:28" },
      scaleOut: false,
    });
    await checkExpectations({ nowMs });
    // the broker verification (orders + positions reads) is the observable:
    // the official test loader sets DAYBOOK_OFF=1, so the exec journal is
    // silenced here — on the VPS the daybook records the verified_absent row.
    assert.ok(ctCalls >= 2, `expected the broker verification reads (orders+positions), got ${ctCalls} — the machinery stalled before verification`);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.EXECUTE_LIVE;
    delete process.env.GC_DATA_DIR;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.CROSSTRADE_KEY;
    delete process.env.CROSSTRADE_ACCOUNT;
  }
});

/* ---- limit-fill matching (2026-10-13 10:16 missed-fill incident) ---- */

test("findMatchingFill: a limit fill past the 5-minute window but inside the limit expiry still matches", () => {
  // the 10:16 card's true shape: card ts 14:17:43Z, limit 30786.13,
  // fill printed +6m51s at 30787.75 — 111s past MATCH_WINDOW_MS.
  const cardTs = Date.parse("2026-10-13T14:17:43.176Z");
  const e: { ts: number; intent: { dir: "long" | "short"; contracts: number } } = {
    ts: cardTs,
    intent: { dir: "short", contracts: 7 },
  };
  const fills = [{ ts: cardTs + 6 * 60_000 + 51_000, action: "Sell", qty: 7, price: 30787.75 }];
  // the default window misses it (the shipped bug) …
  assert.equal(findMatchingFill(e, fills, 0), null);
  // … the limit-lifecycle window catches it
  const hit = findMatchingFill(e, fills, 0, { upperBoundMs: cardTs + 9 * 60_000, limitPrice: 30786.13 });
  assert.ok(hit, "expected the late limit fill to match inside the limit's expiry");
  assert.equal(hit?.price, 30787.75);
});

test("findMatchingFill: limit matching rejects fills beyond the price tolerance (manual-fill guard)", () => {
  const e: { ts: number; intent: { dir: "long" | "short"; contracts: number } } = {
    ts: 0,
    intent: { dir: "long", contracts: 10 },
  };
  const far = [{ ts: 60_000, action: "Buy", qty: 10, price: 31000 }]; // 200 pts off the limit
  assert.equal(findMatchingFill(e, far, 0, { upperBoundMs: 600_000, limitPrice: 30800 }), null);
  const near = [{ ts: 60_000, action: "Buy", qty: 10, price: 30804 }]; // 4 pts off — ours
  assert.ok(findMatchingFill(e, near, 0, { upperBoundMs: 600_000, limitPrice: 30800 }));
});

test("attachLimitOrderId before registerExpectation: the parked id lands on the card (the placement race)", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { attachLimitOrderId, registerExpectation, placedLimitOrderIds, __resetExecWatchForTest } = await import("../lib/execWatch");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ct-watch-"));
  process.env.GC_DATA_DIR = tmp;
  delete process.env.DATABASE_URL; // never touch Neon from a unit test
  process.env.EXECUTE_LIVE = "1";
  process.env.CROSSTRADE_KEY = "test-key";
  process.env.CROSSTRADE_ACCOUNT = "MFFUEVREOD1234";
  process.env.TELEGRAM_BOT_TOKEN = "1:fake";
  process.env.TELEGRAM_CHAT_ID = "1";
  try {
    __resetExecWatchForTest();
    const key = "rth|2026-10-13|short|10:16";
    // the shipped race: the placement promise resolved (id attached)
    // BEFORE the feed's registerExpectation ran
    attachLimitOrderId(key, "mv6rmkmm-z9e7p7-lmt");
    registerExpectation({
      key,
      ts: Date.parse("2026-10-13T14:17:43.176Z"),
      label: "rth short",
      intent: { symbol: "NQ", dir: "short", contracts: 7, entry: 30786.13, stop: 30792.44, target: 30770.34, timeET: "10:16" },
      limit: { price: 30786.13, expireAtMs: Date.parse("2026-10-13T14:17:43.176Z") + 9 * 60_000 },
      scaleOut: false,
    });
    // the expiry cancel must be able to address the order it placed
    assert.deepEqual(placedLimitOrderIds(), ["mv6rmkmm-z9e7p7-lmt"]);
  } finally {
    __resetExecWatchForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.EXECUTE_LIVE;
    delete process.env.GC_DATA_DIR;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.CROSSTRADE_KEY;
    delete process.env.CROSSTRADE_ACCOUNT;
  }
});

