/* Unit tests for lib/tradovateMdProtocol.ts — the Tradovate md
 * WebSocket frame format, verified against the official
 * tradovate/example-api-js SDK (EX-10a-Chart-Data-Solution). */

import { test } from "node:test";
import assert from "node:assert";
import {
  encodeRequest,
  errorTextOf,
  HEARTBEAT_INTERVAL_MS,
  isSuccess,
  parseFrame,
  penaltyOf,
  shouldSendHeartbeat,
  tickChartBody,
} from "../lib/tradovateMdProtocol";

test("encodeRequest matches the official SDK frame format", () => {
  // authorize takes the raw token as its body — a JSON-stringified string
  assert.equal(encodeRequest("authorize", 0, "TOK123"), 'authorize\n0\n\n"TOK123"');
  assert.equal(
    encodeRequest("md/subscribequote", 3, { symbol: "NQM7" }),
    'md/subscribequote\n3\n\n{"symbol":"NQM7"}',
  );
  // the query slot sits between id and body
  assert.equal(encodeRequest("x", 7, { a: 1 }, "q=1"), 'x\n7\nq=1\n{"a":1}');
});

test("parseFrame splits type tag and items", () => {
  assert.deepEqual(parseFrame("o"), { type: "o", data: [] }); // bare open prompt
  assert.deepEqual(parseFrame("h"), { type: "h", data: [] });
  assert.deepEqual(parseFrame("c"), { type: "c", data: [] });

  const data = parseFrame('a[{"i":1,"s":200,"d":{"realtimeId":42}}]');
  assert.equal(data.type, "a");
  assert.equal(data.data.length, 1);
  assert.equal(data.data[0].i, 1);
  assert.equal(data.data[0].s, 200);

  // a lone item is still wrapped as a one-element array
  const lone = parseFrame('a{"e":"md","d":{"quotes":[]}}');
  assert.equal(lone.type, "a");
  assert.equal(lone.data.length, 1);
  assert.equal(lone.data[0].e, "md");

  // heartbeat answers and unparseable payloads never throw
  assert.deepEqual(parseFrame("a[]"), { type: "a", data: [] });
  assert.deepEqual(parseFrame("agarbage"), { type: "a", data: [] });
  assert.deepEqual(parseFrame(""), { type: "", data: [] });
  assert.equal(parseFrame({ toString: () => "h" } as unknown as string).type, "h");
});

test("shouldSendHeartbeat follows the SDK's 2.5s idle cadence", () => {
  assert.equal(shouldSendHeartbeat(10_000, 10_000 - HEARTBEAT_INTERVAL_MS + 1), false);
  assert.equal(shouldSendHeartbeat(10_000, 10_000 - HEARTBEAT_INTERVAL_MS), true);
  assert.equal(shouldSendHeartbeat(10_000, 0), true);
});

test("penaltyOf surfaces p-ticket/p-time and captcha", () => {
  assert.deepEqual(penaltyOf({ "p-ticket": 7, "p-time": 3 }), { ticket: 7, time: 3, captcha: undefined });
  assert.deepEqual(penaltyOf({ "p-ticket": 9, "p-time": 1, "p-captcha": true }), {
    ticket: 9,
    time: 1,
    captcha: true,
  });
  assert.equal(penaltyOf({ errorText: "nope" }), null);
  assert.equal(penaltyOf(undefined), null);
  assert.equal(penaltyOf("str"), null);
});

test("isSuccess and errorTextOf interpret response items", () => {
  assert.equal(isSuccess({ i: 1, s: 200, d: {} }), true);
  assert.equal(isSuccess({ i: 1, s: 401, d: {} }), false);
  assert.equal(errorTextOf({ s: 401, d: { errorText: "Token expired" } }), "Token expired");
  assert.equal(errorTextOf({ s: 500, d: {} }), "{}");
});

test("tickChartBody is the §7 footprint tick recipe", () => {
  const body = tickChartBody("NQM7", 10);
  assert.deepEqual(body, {
    symbol: "NQM7",
    chartDescription: {
      underlyingType: "Tick",
      elementSize: 1,
      elementSizeUnit: "UnderlyingUnits",
      withHistogram: false,
    },
    timeRange: { asMuchAsElements: 10 },
  });
  // timeRange carries ≥1 optional field as the schema requires
  assert.ok(Object.keys(body.timeRange as object).length >= 1);
});
