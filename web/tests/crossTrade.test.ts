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
  classifyResponse,
  MNQ_TICK,
  type CrossTradeConfig,
} from "../lib/crossTrade";
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
