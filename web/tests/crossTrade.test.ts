/* Unit tests for the CrossTrade webhook executor (lib/crossTrade.ts):
 * symbol mapping, bracket tick math, payload shape, and the safety
 * rules that must never regress (qty cap, no unknown fields, no retry
 * semantics live in placeCrossTradeOrder — the payload is what a bad
 * mapping or tick slip would corrupt, so it is tested exhaustively). */
import { test } from "node:test";
import assert from "node:assert";
import {
  mapInstrument,
  buildCrossTradePayload,
  buildChangePayload,
  splitScaleOut,
  classifyResponse,
  stopCrossedAtDispatch,
  limitCrossedAtDispatch,
  approachGateBlocked,
  reanchorBracketForFill,
  buildReArmBracketPayload,
  maxContracts,
  confirmFlatREST,
  tapeFreshForDispatch,
  TAPE_FRESH_MS,
  MNQ_TICK,
  type CrossTradeConfig,
} from "../lib/crossTrade";
import { __resetCtAccountForTest } from "../lib/ctAccount";
import type { OrderIntent } from "../lib/executor";

const CFG: CrossTradeConfig = {
  url: "https://app.crosstrade.io/v1/send/test-uid/test-channel",
  key: "test-secret",
  account: "MFF-50k",
  requireFlat: true,
};

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: "NQZ26",
  dir: "long",
  contracts: 9,
  entry: 21850.0,
  stop: 21847.5,
  target: 21860.0,
  timeET: "09:45 NY",
  ...over,
});

test("mapInstrument: GoCharting NQ contract → Tradovate MNQ (1-digit year)", () => {
  assert.equal(mapInstrument("NQZ26"), "MNQZ6"); // Dec 2026 → Z6
  assert.equal(mapInstrument("NQH27"), "MNQH7"); // Mar 2027 → H7
  assert.equal(mapInstrument("NQM26"), "MNQM6"); // Jun 2026 → M6
});

test("mapInstrument: Tradovate-shaped and continuous values pass through", () => {
  assert.equal(mapInstrument("MNQZ6"), "MNQZ6");
  assert.equal(mapInstrument("MNQ1!"), "MNQ1!");
});

test("mapInstrument: env override wins", () => {
  assert.equal(mapInstrument("NQZ26", "MNQ1!"), "MNQ1!");
});

test("mapInstrument: unmappable symbols return null, never a guess", () => {
  assert.equal(mapInstrument("ESZ26"), null); // ES is a different product
  assert.equal(mapInstrument("NQZ260"), null);
  assert.equal(mapInstrument(""), null);
});

test("payload: action follows direction, qty is floored and capped at 30 micro", () => {
  const buy = buildCrossTradePayload(intent({ dir: "long" }), CFG);
  assert.equal(buy.action, "buy");
  const sell = buildCrossTradePayload(intent({ dir: "short", contracts: 0 }), CFG);
  assert.equal(sell.action, "sell");
  assert.equal(sell.qty, 1); // floor
  const huge = buildCrossTradePayload(intent({ contracts: 500 }), CFG);
  assert.equal(huge.qty, 30); // MFF 30-micro cap
});

test("payload: stop/target convert to MNQ ticks (0.25 pt per tick)", () => {
  // entry 21850.00 → stop 21847.50 = 2.50 pts = 10 ticks
  // entry 21850.00 → target 21860.00 = 10 pts = 40 ticks
  const p = buildCrossTradePayload(intent(), CFG);
  assert.equal(p.stop_loss, "10 ticks");
  assert.equal(p.take_profit, "40 ticks");
  // fractional points round to whole ticks, minimum 1
  const tight = buildCrossTradePayload(intent({ stop: 21849.9, target: 21850.1 }), CFG);
  assert.equal(tight.stop_loss, "1 ticks");
  assert.equal(tight.take_profit, "1 ticks");
  assert.equal(MNQ_TICK, 0.25, "MNQ tick size must stay 0.25 — sizing math depends on it");
});

test("payload: only CrossTrade schema fields are present (unknown fields are rejected)", () => {
  const p = buildCrossTradePayload(intent(), CFG);
  const keys = Object.keys(p).sort();
  assert.deepEqual(keys, [
    "account",
    "action",
    "command",
    "destination",
    "instrument",
    "key",
    "order_type",
    "qty",
    "require_market_position",
    "stop_loss",
    "take_profit",
    "tif",
  ]);
  assert.equal(p.command, "place");
  assert.equal(p.destination, "tradovate");
  assert.equal(p.order_type, "market");
  assert.equal(p.tif, "day");
  assert.equal(p.account, "MFF-50k");
  assert.equal(p.instrument, "MNQZ6");
  assert.equal(p.require_market_position, "flat");
});

test("payload: require_market_position is omitted when flat-requirement is off", () => {
  const p = buildCrossTradePayload(intent(), { ...CFG, requireFlat: false });
  assert.ok(!("require_market_position" in p));
});

test("payload: unmappable instrument throws instead of submitting garbage", () => {
  assert.throws(() => buildCrossTradePayload(intent({ symbol: "ESZ26" }), CFG));
});

test("payload: non-finite bracket prices throw (never submit NaN ticks)", () => {
  assert.throws(() => buildCrossTradePayload(intent({ stop: Number.NaN }), CFG));
  assert.throws(() => buildCrossTradePayload(intent({ target: Infinity }), CFG));
});

test("classifyResponse: HTTP 200 with an error body is a REJECTION (verified live)", () => {
  // the live endpoint answered 200 + {"error": "Secret key is missing, invalid, or inactive."}
  const r = classifyResponse(200, '{"error": "Secret key is missing, invalid, or inactive."}');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Secret key/);
});

test("classifyResponse: HTTP 200 with a non-error body is accepted", () => {
  assert.equal(classifyResponse(200, '{"message":"ok"}').ok, true);
  assert.equal(classifyResponse(200, "").ok, true);
  assert.equal(classifyResponse(200, "plain text ack").ok, true);
});

test("classifyResponse: non-2xx is a rejection regardless of body", () => {
  assert.equal(classifyResponse(400, "bad").ok, false);
  assert.equal(classifyResponse(500, "").ok, false);
  assert.equal(classifyResponse(401, '{"error":"x"}').ok, false);
});

test("change: buildChangePayload formats absolute stop + trail ticks, requires a field", () => {
  const stop = buildChangePayload(CFG, { orderId: "abc-run", stopPrice: 21847.5 });
  assert.equal(stop.command, "change");
  assert.equal(stop.destination, "tradovate");
  assert.equal(stop.order_id, "abc-run");
  assert.equal(stop.stop_price, "21847.50");
  const trail = buildChangePayload(CFG, { orderId: "abc-run", trailOffsetTicks: 10 });
  assert.equal(trail.trail_offset, "10 ticks");
  assert.ok(!("stop_price" in trail));
  assert.throws(() => buildChangePayload(CFG, { orderId: "x" }));
  assert.throws(() => buildChangePayload(CFG, { orderId: "x", stopPrice: Number.NaN }));
});

test("scaleout: splitScaleOut banks 2/3 and floors tiny sizes", () => {
  const s9 = splitScaleOut(intent({ contracts: 9 }));
  assert.equal(s9.bank.contracts, 6);
  assert.equal(s9.runner.contracts, 3);
  const s2 = splitScaleOut(intent({ contracts: 2 }));
  assert.equal(s2.bank.contracts, 1);
  assert.equal(s2.runner.contracts, 1);
  const s1 = splitScaleOut(intent({ contracts: 1 }));
  assert.equal(s1.bank.contracts, 1);
  assert.equal(s1.runner.contracts, 0); // single-leg fallback
});

test("payload: order_id attached and take_profit omitted for the runner leg", () => {
  const p = buildCrossTradePayload(intent(), CFG, { orderId: "abc-run", withTarget: false });
  assert.equal(p.order_id, "abc-run");
  assert.ok(!("take_profit" in p));
  assert.equal(p.stop_loss, "10 ticks");
});

import { stackGuardDecision, __resetLatchForTest } from "../lib/crossTrade";

test("stackGuardDecision: temporal barrier, then confirmed-flat, then hold", () => {
  __resetLatchForTest();
  // no latch: read decides
  assert.equal(stackGuardDecision(false, 999_999, 0), "allow");
  assert.equal(stackGuardDecision(false, 999_999, 9), "refuse_position_open");
  // just placed: refuse regardless of the read (stale reads lie)
  assert.equal(stackGuardDecision(true, 5_000, 0), "refuse_recent_entry");
  assert.equal(stackGuardDecision(true, 30_000, 0), "refuse_recent_entry");
  // after 60s: the read must confirm flat
  assert.equal(stackGuardDecision(true, 61_000, 9), "refuse_position_open");
  assert.equal(stackGuardDecision(true, 61_000, null), "refuse_recent_entry"); // unreadable
  assert.equal(stackGuardDecision(true, 61_000, 0), "confirm_flat");
  __resetLatchForTest();
});

import { buildRESTPlacePayload, placeCrossTradeScaleOutREST } from "../lib/crossTrade";
import { placeScaleOut } from "../lib/executor";

test("REST payload: ABSOLUTE stop/target at the signal's structural levels", () => {
  const p = buildRESTPlacePayload(intent(), CFG);
  assert.equal(p.instrument, "MNQZ6");
  assert.equal(p.action, "buy");
  assert.equal(p.orderType, "market");
  assert.equal(p.tif, "day");
  assert.equal(p.stopLoss, "21847.50"); // absolute — never a tick distance
  assert.equal(p.takeProfit, "21860.00");
  assert.equal(p.qty, 9);
});

test("REST payload: runner leg omits takeProfit, keeps absolute stop", () => {
  const p = buildRESTPlacePayload(intent(), CFG, { orderId: "abc-run", withTarget: false });
  assert.ok(!("takeProfit" in p));
  assert.equal(p.stopLoss, "21847.50");
  assert.equal(p.orderId, "abc-run");
});

test("REST payload: limit entry carries limitPrice + our order id", () => {
  const p = buildRESTPlacePayload(intent(), CFG, { orderId: "abc-lmt", limitPrice: 21846.5 });
  assert.equal(p.orderType, "limit");
  assert.equal(p.limitPrice, 21846.5);
  assert.equal(p.orderId, "abc-lmt"); // cancel later addresses OUR id
  assert.equal(p.takeProfit, "21860.00"); // brackets still exchange-side
  assert.throws(() => buildRESTPlacePayload(intent(), CFG, { limitPrice: Number.NaN }));
});

test("REST payload: qty floored/capped, throws on garbage", () => {
  assert.equal(buildRESTPlacePayload(intent({ contracts: 0 }), CFG).qty, 1);
  assert.equal(buildRESTPlacePayload(intent({ contracts: 500 }), CFG).qty, 30);
  assert.throws(() => buildRESTPlacePayload(intent({ symbol: "ESZ26" }), CFG));
  assert.throws(() => buildRESTPlacePayload(intent({ stop: Number.NaN }), CFG));
  assert.throws(() => buildRESTPlacePayload(intent({ target: Infinity }), CFG));
});

test("REST scale-out: dry-run splits the pair with our order ids (no fetch)", () => {
  return placeCrossTradeScaleOutREST(intent({ contracts: 9 })).then((r) => {
    assert.equal(r.ok, true);
    assert.match(r.reason, /dry-run/);
    assert.match(r.bankOrderId ?? "", /-bank$/);
    assert.match(r.runnerOrderId ?? "", /-run$/);
    assert.equal(r.runnerQty, 3);
  });
});

test("REST scale-out: 1-contract intent falls back to a single dry-run order", () => {
  return placeCrossTradeScaleOutREST(intent({ contracts: 1 })).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.bankOrderId, undefined);
    assert.equal(r.runnerQty, undefined);
  });
});

test("placeScaleOut: not configured returns refused without any network", () => {
  // CROSSTRADE_* unset in the test env → crossTradeEnabled() false
  return placeScaleOut(intent({ contracts: 9 })).then((r) => {
    assert.equal(r.ok, false);
    assert.match(r.reason, /not configured/);
  });
});

/* ---- crossed-stop dispatch gate (2026-10-08 naked-position incident) ---- */

test("stopCrossedAtDispatch: long — tape below the stop is crossed (stop would be rejected)", () => {
  assert.equal(stopCrossedAtDispatch("long", 21847.5, 21847.25), true);
  assert.equal(stopCrossedAtDispatch("long", 21847.5, 21847.5), true); // exactly AT the stop
});

test("stopCrossedAtDispatch: long — tape above the stop is safe", () => {
  assert.equal(stopCrossedAtDispatch("long", 21847.5, 21850.0), false);
});

test("stopCrossedAtDispatch: short — tape above the stop is crossed (the 09:48 incident shape)", () => {
  // short stop 31222.75, market 31229.25 at dispatch → InvalidPrice rejection
  assert.equal(stopCrossedAtDispatch("short", 31222.75, 31229.25), true);
  assert.equal(stopCrossedAtDispatch("short", 31222.75, 31222.75), true);
});

test("stopCrossedAtDispatch: short — tape below the stop is safe", () => {
  assert.equal(stopCrossedAtDispatch("short", 31222.75, 31216.25), false);
});

test("stopCrossedAtDispatch: unknown tape (null/undefined/NaN) → null (allow, fail open)", () => {
  assert.equal(stopCrossedAtDispatch("long", 21847.5, null), null);
  assert.equal(stopCrossedAtDispatch("short", 31222.75, undefined), null);
  assert.equal(stopCrossedAtDispatch("short", 31222.75, Number.NaN), null);
  assert.equal(stopCrossedAtDispatch("short", Number.NaN, 31229.25), null);
});

/* ---- crossed-limit dispatch gate + fill re-anchor (2026-10-08 −$1,056 event) ---- */

test("limitCrossedAtDispatch: short — tape above the limit is crossed (the 12:16 shape)", () => {
  assert.equal(limitCrossedAtDispatch("short", 31187.375, 31189.75), true); // 2.4 pts through
  assert.equal(limitCrossedAtDispatch("short", 31187.375, 31189.75, 3), false); // inside threshold
});

test("limitCrossedAtDispatch: long — tape below the limit is crossed", () => {
  assert.equal(limitCrossedAtDispatch("long", 31245.125, 31242.0), true);
});

test("limitCrossedAtDispatch: sub-tick crossings pass (the clean 10:10/11:31 fills)", () => {
  assert.equal(limitCrossedAtDispatch("short", 31231.875, 31232.0), false); // 0.125 pts
  assert.equal(limitCrossedAtDispatch("long", 31245.125, 31245.0), false);
});

test("limitCrossedAtDispatch: unknown tape → null (fail open)", () => {
  assert.equal(limitCrossedAtDispatch("short", 31187.375, null), null);
  assert.equal(limitCrossedAtDispatch("long", 31245.125, Number.NaN), null);
});

/* ---- crossed-limit approach gate (rthLimitFillDriftStudy 2026-10-13) ---- */

test("approachGateBlocked: short — tape just below the sell limit is the about-to-fill cohort", () => {
  assert.equal(approachGateBlocked("short", 30786.13, 30785.0, 2), true); // 1.13 pts away
  assert.equal(approachGateBlocked("short", 30786.13, 30784.13, 2), true); // exactly at the edge
  assert.equal(approachGateBlocked("short", 30786.13, 30783.0, 2), false); // 3.13 pts away
});

test("approachGateBlocked: long — tape just above the buy limit is the about-to-fill cohort", () => {
  assert.equal(approachGateBlocked("long", 30704.75, 30706.0, 2), true); // 1.25 pts away
  assert.equal(approachGateBlocked("long", 30704.75, 30708.0, 2), false); // 3.25 pts away
});

test("approachGateBlocked: tape at or through the limit belongs to the crossed gate, not the approach gate", () => {
  assert.equal(approachGateBlocked("short", 30786.13, 30786.13, 2), false); // exactly at the limit
  assert.equal(approachGateBlocked("short", 30786.13, 30789.0, 2), false); // through (crossed-limit territory)
  assert.equal(approachGateBlocked("long", 30704.75, 30704.75, 2), false);
  assert.equal(approachGateBlocked("long", 30704.75, 30702.0, 2), false);
});

test("approachGateBlocked: unknown tape or non-positive threshold → never gate", () => {
  assert.equal(approachGateBlocked("short", 30786.13, null, 2), null);
  assert.equal(approachGateBlocked("short", 30786.13, Number.NaN, 2), null);
  assert.equal(approachGateBlocked("short", 30786.13, 30785.0, 0), false);
  assert.equal(approachGateBlocked("short", 30786.13, 30785.0, Number.NaN), false);
});

test("reanchorBracketForFill: drifted fill compresses the stop → re-anchor to the fill (the 12:16 shape)", () => {
  // short: signal 31187.375, stop 31190.56 (3.19 above), target 31179.41;
  // fill drifted 2.4 pts up → actual stop distance 0.81 pts < 50% of planned
  const re = reanchorBracketForFill(intent({ dir: "short", entry: 31187.375, stop: 31190.56, target: 31179.41 }), 31189.75);
  assert.ok(re);
  assert.ok(Math.abs(re!.stop - 31192.94) < 0.01); // fill + planned 3.19
  assert.ok(Math.abs(re!.target - 31181.78) < 0.01); // fill − planned 7.97
});

test("reanchorBracketForFill: healthy fill (no drift) → null", () => {
  assert.equal(reanchorBracketForFill(intent({ dir: "short", entry: 31231.875, stop: 31238.76, target: 31216.05 }), 31232.0), null);
});

test("reanchorBracketForFill: non-finite fill → null", () => {
  assert.equal(reanchorBracketForFill(intent(), Number.NaN), null);
});

/* ---- re-arm payload (cancel_and_bracket) — the 2026-10-12 recurrence ---- */

test("re-arm payload: cancel_and_bracket carries QTY (the missing-QTY 400 regression)", () => {
  // live 2026-10-12: {"success":false,"error":"Missing required field(s) for cancelandbracket: QTY"}
  const p = buildReArmBracketPayload({ symbol: "NQZ26", dir: "short", stopPrice: 30886.0, targetPrice: 30854.84, qty: 7 }, CFG);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  // 30854.84 is off the 0.25 tick — sent tick-aligned toward the entry (2026-10-26)
  assert.deepEqual(p, { instrument: "MNQZ6", action: "sell", takeProfit: "30855.00", stopLoss: "30886.00", qty: 7 });
});

test("re-arm payload: action follows the protected side, qty floors to whole contracts", () => {
  const long = buildReArmBracketPayload({ symbol: "NQZ26", dir: "long", stopPrice: 100.25, targetPrice: 110.5, qty: 3.9 }, CFG);
  if ("error" in long) {
    assert.fail("unexpected error");
    return;
  }
  assert.equal(long.action, "buy");
  assert.equal(long.qty, 3);
  const short = buildReArmBracketPayload({ symbol: "NQZ26", dir: "short", stopPrice: 100.25, targetPrice: 110.5, qty: 7 }, CFG);
  if ("error" in short) {
    assert.fail("unexpected error");
    return;
  }
  assert.equal(short.action, "sell");
  assert.equal(short.stopLoss, "100.25");
  assert.equal(short.takeProfit, "110.50");
});

test("re-arm payload: bad symbol, non-finite prices, or non-positive qty refuse", () => {
  assert.ok("error" in buildReArmBracketPayload({ symbol: "ESZ26", dir: "long", stopPrice: 1, targetPrice: 2, qty: 1 }, CFG));
  assert.ok("error" in buildReArmBracketPayload({ symbol: "NQZ26", dir: "long", stopPrice: Number.NaN, targetPrice: 2, qty: 1 }, CFG));
  assert.ok("error" in buildReArmBracketPayload({ symbol: "NQZ26", dir: "long", stopPrice: 1, targetPrice: Infinity, qty: 1 }, CFG));
  assert.ok("error" in buildReArmBracketPayload({ symbol: "NQZ26", dir: "long", stopPrice: 1, targetPrice: 2, qty: 0 }, CFG));
  assert.ok("error" in buildReArmBracketPayload({ symbol: "NQZ26", dir: "long", stopPrice: 1, targetPrice: 2, qty: Number.NaN }, CFG));
});

/* ---------------- the ONE contract cap (planMaxMicro) ---------------- */

test("maxContracts delegates to planMaxMicro — MAX_MICRO_CONTRACTS env, default the plan 30µ", () => {
  delete process.env.MAX_MICRO_CONTRACTS;
  assert.equal(maxContracts(), 30, "absent → plan default 30");
  process.env.MAX_MICRO_CONTRACTS = "8";
  assert.equal(maxContracts(), 8, "live cap 8");
  process.env.MAX_MICRO_CONTRACTS = "0"; // invalid → default
  assert.equal(maxContracts(), 30);
  process.env.MAX_MICRO_CONTRACTS = "2.7"; // floors
  assert.equal(maxContracts(), 2);
  delete process.env.MAX_MICRO_CONTRACTS;
  assert.equal(maxContracts(), 30);
});

/* ------- flat confirmation + stale-tape refusal (2026-10-15) --------- *
 * The naked-stop incident: a single positions read 0.2s after the fill
 * read "flat" (vendor reconciliation lag / degraded empty-list response)
 * while an 8-lot short was open — the repair aborted silently. Flat must
 * now be double-confirmed, and unreadable is never all-clear. */

const posFetch = (seq: Array<"flat" | "open" | "err">) => {
  let reads = 0;
  return {
    reads: () => reads,
    fetchFn: (async () => {
      const s = seq[Math.min(reads, seq.length - 1)];
      reads += 1;
      if (s === "err") return { status: 500, text: async () => "boom" };
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ success: true, data: s === "flat" ? [] : [{ instrument: "MNQZ6", netPos: -8 }] }),
      };
    }) as unknown as typeof fetch,
  };
};

test("confirmFlatREST: flat is only confirmed by two consistent reads", async () => {
  __resetCtAccountForTest({ gapMs: 0 });
  const flatFlat = posFetch(["flat", "flat"]);
  assert.equal(await confirmFlatREST({ confirmDelayMs: 0, fetchFn: flatFlat.fetchFn }), "flat");
  assert.equal(flatFlat.reads(), 2, "both reads taken before the flat verdict");
});

test("confirmFlatREST: a later position sighting overrides an early flat read", async () => {
  __resetCtAccountForTest({ gapMs: 0 });
  const flatOpen = posFetch(["flat", "open"]);
  assert.equal(await confirmFlatREST({ confirmDelayMs: 0, fetchFn: flatOpen.fetchFn }), "open");
  assert.equal(flatOpen.reads(), 2);
});

test("confirmFlatREST: open/unreadable first reads short-circuit (no silent wait)", async () => {
  __resetCtAccountForTest({ gapMs: 0 });
  const open = posFetch(["open"]);
  assert.equal(await confirmFlatREST({ confirmDelayMs: 0, fetchFn: open.fetchFn }), "open");
  assert.equal(open.reads(), 1, "open on the first read needs no second read");
  const err = posFetch(["err"]);
  assert.equal(await confirmFlatREST({ confirmDelayMs: 0, fetchFn: err.fetchFn }), "unreadable");
  assert.equal(err.reads(), 1);
});

test("confirmFlatREST: a degraded second read is never all-clear", async () => {
  __resetCtAccountForTest({ gapMs: 0 });
  const flatErr = posFetch(["flat", "err"]);
  assert.equal(await confirmFlatREST({ confirmDelayMs: 0, fetchFn: flatErr.fetchFn }), "unreadable");
  assert.equal(flatErr.reads(), 2);
});

test("tapeFreshForDispatch: limits require a tick within TAPE_FRESH_MS — stale/absent refuse", () => {
  const now = 10_000_000;
  assert.equal(tapeFreshForDispatch(now, now), true, "tick at now");
  assert.equal(tapeFreshForDispatch(now + TAPE_FRESH_MS - 1, now), true, "just inside the window");
  assert.equal(tapeFreshForDispatch(now + TAPE_FRESH_MS, now), false, "at the boundary → stale");
  assert.equal(tapeFreshForDispatch(now + TAPE_FRESH_MS + 60_000, now), false, "deeply stale");
  assert.equal(tapeFreshForDispatch(now, 0), false, "no tick ever → refuse");
  assert.equal(tapeFreshForDispatch(now, null), false, "null tick → refuse");
  assert.equal(tapeFreshForDispatch(now, Number.NaN), false, "garbage tick → refuse");
});


test("REST payload: a NaN contract count is refused, never sent as qty null", () => {
  assert.throws(() => buildRESTPlacePayload({ ...intent(), contracts: Number.NaN }, CFG), /invalid contracts/);
  assert.throws(() => buildRESTPlacePayload({ ...intent(), contracts: Number.POSITIVE_INFINITY }, CFG), /invalid contracts/);
});

import { roundToTick, bracketPriceToTick } from "../lib/crossTrade";

test("tick alignment: every price sent is on the 0.25 tick, rounded the safe way", () => {
  assert.equal(roundToTick(24996.375, "down"), 24996.25);
  assert.equal(roundToTick(24996.375, "up"), 24996.5);
  assert.equal(roundToTick(24996.3, "nearest"), 24996.25);
  assert.equal(roundToTick(24996.25, "down"), 24996.25); // already on tick: unchanged
  assert.equal(roundToTick(24996.25, "up"), 24996.25);
  assert.equal(roundToTick(30014.94, "up"), 30015); // the 2026-10-15 live stop
  // long: stop away from entry (down), target toward entry (down)
  assert.equal(bracketPriceToTick("long", 24996.38), 24996.25);
  assert.equal(bracketPriceToTick("long", 25009.06), 25009);
  // short: stop away from entry (up), target toward entry (up)
  assert.equal(bracketPriceToTick("short", 25003.62), 25003.75);
  assert.equal(bracketPriceToTick("short", 24990.94), 24991);
});

test("REST payload: off-tick stop/target/limit are tick-aligned", () => {
  const p = buildRESTPlacePayload({ ...intent(), stop: 21847.38, target: 21860.06 }, CFG, { limitPrice: 21851.1 });
  assert.equal(p.stopLoss, "21847.25");
  assert.equal(p.takeProfit, "21860.00");
  assert.equal(p.limitPrice, 21851);
  const r = buildReArmBracketPayload({ symbol: "NQZ26", dir: "short", stopPrice: 30014.94, targetPrice: 29990.1, qty: 2 }, CFG);
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.stopLoss, "30015.00");
    assert.equal(r.takeProfit, "29990.25");
  }
});
