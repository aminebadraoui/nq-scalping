import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTradovateCsv, matchRoundTrips } from "../lib/tradovateImport";

const CSV = `symbol,_priceFormat,_priceFormatType,_tickSize,buyFillId,sellFillId,qty,buyPrice,sellPrice,pnl,boughtTimestamp,soldTimestamp,duration
MNQZ6,-2,0,0.25,A1,A2,10,30796.25,30804.25,$160.00,10/01/2026 18:43:09,10/01/2026 18:46:13,3min 3sec
MNQZ6,-2,0,0.25,A3,A4,14,30847.00,30840.75,$(175.00),10/01/2026 19:20:16,10/01/2026 19:21:06,49sec
MNQZ6,-2,0,0.25,A5,A6,8,30888.50,30876.00,$(200.50),10/01/2026 22:59:46,10/01/2026 22:51:33,8min 12sec
MESZ6,-2,0,0.25,A7,A8,1,7731.00,7733.50,$12.50,10/01/2026 19:01:52,10/01/2026 19:22:31,20min 39sec
MNQZ6,-2,0,0.25,A9,A10,9,31109.75,31113.75,$72.00,10/02/2026 12:21:31,10/02/2026 12:20:23,1min 7sec`;

test("parseTradovateCsv: money format, direction from timestamps, ET dates", () => {
  const rows = parseTradovateCsv(CSV);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].pnlUsd, 160);
  assert.equal(rows[1].pnlUsd, -175, "negative $(...) format");
  assert.equal(rows[0].direction, "long", "buy before sell");
  assert.equal(rows[2].direction, "short", "bought back after selling");
  assert.equal(rows[2].entryPrice, 30876, "short entry is the sell price");
  assert.equal(rows[2].exitPrice, 30888.5, "short exit is the buy-back price");
  assert.equal(rows[1].day, "2026-10-01", "exit in ET maps to the ET date");
  assert.equal(rows[4].day, "2026-10-02");
});

test("parseTradovateCsv: skips garbage lines", () => {
  assert.deepEqual(parseTradovateCsv("garbage\n\n,,\n"), []);
});

test("matchRoundTrips: corrects wrong P&L, manual bucket gets the rest", () => {
  const rows = parseTradovateCsv(CSV);
  const trades = [
    { signal_key: "s1", ts: Date.parse("2026-10-01T22:43:00Z"), side: "long", contracts: 10, gross_usd: 0, fill_entry_at: "2026-10-01T22:43:09Z" },
    { signal_key: "s2", ts: Date.parse("2026-10-01T23:20:00Z"), side: "long", contracts: 14, gross_usd: -175, fill_entry_at: "2026-10-01T23:20:16Z" },
    { signal_key: "s3", ts: Date.parse("2026-10-02T16:20:00Z"), side: "short", contracts: 9, gross_usd: 72, fill_entry_at: "2026-10-02T16:20:23Z" },
  ];
  const { matched, manual } = matchRoundTrips(rows, trades);
  assert.equal(matched.length, 3);
  const s1 = matched.find((m) => m.signalKey === "s1")!;
  assert.equal(s1.trip.pnlUsd, 160);
  assert.equal(s1.corrects, true, "journal said 0, Tradovate says 160");
  const s2 = matched.find((m) => m.signalKey === "s2")!;
  assert.equal(s2.corrects, false, "already exact — no update needed");
  const s3 = matched.find((m) => m.signalKey === "s3")!;
  assert.equal(s3.corrects, false);
  assert.equal(manual.length, 2, "the short round trip and the MES trip are manual");
  assert.deepEqual(manual.map((m) => m.symbol), ["MNQZ6", "MESZ6"]);
});
