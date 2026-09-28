/* Decoder for the FOOTPRINT/V2 protobuf response (bootstrap path). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFootprintForDateResponse,
  splitFrame,
} from "../lib/footprintProto.ts";

// Serialized by gcdata/footprint_pb2.py (the same proto the vendor serves):
// three ETH candles for 2026-09-28 with real high/low/buy/sell and nested
// footprint levels, so field-skipping is exercised too.
const HEX =
  "0a290a03434d4512064655545552451a054e515a32362202316d2a03455448320a323032362d30392d3238" +
  "12620a19323032362d30392d32375431373a30303a30302d30353a3030120f086f1084013888cebb0140d7bcbb01" +
  "1a0e0a0310f3011202106f1a0310840132110888cebb011204080110011a0408011001321108efcdbb011204080210021a0408031003" +
  "12640a19323032362d30392d32375431373a30313a30302d30353a3030121008c80110960138eccebb0140c0ccbb01" +
  "1a0f0a0310de02120310c8011a0310960132110888cebb011204080110011a0408011001321108efcdbb011204080210021a0408031003" +
  "12620a19323032362d30392d32385431353a35393a30302d30353a3030120f0866108e013881debc0140d8dabc01" +
  "1a0e0a0310f401120210661a03108e0132110888cebb011204080110011a0408011001321108efcdbb011204080210021a0408031003" +
  "1a0808191019180120022802";

function fromHex(h) {
  return new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));
}

test("decodes request date/session and every candle's high/low/buy/sell", () => {
  const r = decodeFootprintForDateResponse(fromHex(HEX));
  assert.equal(r.requestDate, "2026-09-28");
  assert.equal(r.session, "ETH");
  assert.ok(!r.isComplete, "is_complete is omitted by proto3 when false");
  assert.equal(r.candles.length, 3);

  const [a, b, c] = r.candles;
  assert.equal(a.t, "2026-09-27T17:00:00-05:00");
  assert.equal(a.high, 3073800);
  assert.equal(a.low, 3071575);
  assert.equal(a.buy, 111);
  assert.equal(a.sell, 132);

  assert.equal(b.t, "2026-09-27T17:01:00-05:00");
  assert.equal(b.high, 3073900);
  assert.equal(b.buy, 200);
  assert.equal(b.sell, 150);

  assert.equal(c.t, "2026-09-28T15:59:00-05:00");
  assert.equal(c.high, 3092225);
  assert.equal(c.low, 3091800);
});

test("empty / malformed input never throws", () => {
  assert.deepEqual(decodeFootprintForDateResponse(new Uint8Array(0)), {
    candles: [],
  });
  assert.equal(splitFrame(new Uint8Array(2)), null);
});

test("splitFrame extracts the text header and protobuf body", () => {
  const header = "FOOTPRINT/V2~x~1";
  const body = new Uint8Array([0x08, 0x01]);
  const buf = new Uint8Array(5 + header.length + body.length);
  buf[4] = header.length;
  for (let i = 0; i < header.length; i++) buf[5 + i] = header.charCodeAt(i);
  buf.set(body, 5 + header.length);
  const f = splitFrame(buf);
  assert.equal(f.header, header);
  assert.deepEqual([...f.body], [0x08, 0x01]);
});
