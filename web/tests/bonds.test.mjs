/* US Treasury curve parsing + derived spreads (lib/bonds.ts) — pure,
 * offline tests over inline fixtures that mirror the live feed layout
 * (quoted header labels, M/D/YYYY dates, newest-first rows). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTreasuryCsv,
  parseRealYieldCsv,
  buildBondsData,
  bpDiff,
  spread210,
  spread103m,
  breakeven10y,
} from "../lib/bonds.ts";

const NOMINAL = [
  'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"',
  "10/02/2026,4.04,4.09,4.11,4.19,4.26,4.27,4.46,4.83,4.96,5.06,5.17,5.28,5.67,5.63",
  "10/01/2026,4.06,4.10,4.13,4.17,4.26,4.27,4.44,4.78,4.91,5.01,5.12,5.24,5.64,5.61",
  "09/30/2026,4.02,4.13,4.16,4.20,4.29,4.33,4.54,4.88,5.00,5.09,5.19,5.29,5.68,5.64",
].join("\n");

const REAL = [
  'Date,"5 YR","7 YR","10 YR","20 YR","30 YR"',
  "10/02/2026,2.69,2.80,2.92,3.19,3.34",
  "10/01/2026,2.65,2.76,2.88,3.16,3.31",
].join("\n");

test("parses the nominal curve newest-first with header-mapped columns", () => {
  const rows = parseTreasuryCsv(NOMINAL);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, "2026-10-02");
  assert.equal(rows[0].y10, 5.28);
  assert.equal(rows[0].m3, 4.19);
  assert.equal(rows[0].y30, 5.63);
  assert.equal(rows[2].date, "2026-09-30");
});

test("reorders rows oldest→newest regardless of feed order", () => {
  const rev = [
    'Date,"2 Yr","10 Yr"',
    "09/30/2026,4.88,5.29",
    "10/02/2026,4.83,5.28",
  ].join("\n");
  const rows = parseTreasuryCsv(rev);
  assert.equal(rows[0].date, "2026-10-02");
  assert.equal(rows[1].date, "2026-09-30");
});

test("unknown columns are ignored, missing ones become null", () => {
  const partial = ['Date,"10 Yr"', "10/02/2026,5.28"].join("\n");
  const [row] = parseTreasuryCsv(partial);
  assert.equal(row.y10, 5.28);
  assert.equal(row.m1, null);
  assert.equal(row.y30, null);
});

test("garbage rows and empty values are skipped safely", () => {
  const messy = ['Date,"2 Yr","10 Yr"', "not-a-date,1,2", "10/02/2026,,5.28", ""].join("\n");
  const rows = parseTreasuryCsv(messy);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].y2, null);
  assert.equal(rows[0].y10, 5.28);
});

test("spreads: 2s10s and 10y−3m in basis points", () => {
  const [latest] = parseTreasuryCsv(NOMINAL);
  assert.equal(spread210(latest), Math.round((5.28 - 4.83) * 100)); // +45
  assert.equal(spread103m(latest), Math.round((5.28 - 4.19) * 100)); // +109
});

test("spreads are null when a leg is missing", () => {
  const row = parseTreasuryCsv(['Date,"2 Yr","10 Yr"', "10/02/2026,,5.28"].join("\n"))[0];
  assert.equal(spread210(row), null);
  assert.equal(spread103m(row), null);
});

test("bp diff between consecutive rows", () => {
  const rows = parseTreasuryCsv(NOMINAL);
  assert.equal(bpDiff(rows[0].y10, rows[1].y10), 4); // 5.28 − 5.24
  assert.equal(bpDiff(rows[0].m1, rows[1].m1), -2);
  assert.equal(bpDiff(rows[0].y10, null), null);
});

test("real yield rows parse and pair by date", () => {
  const real = parseRealYieldCsv(REAL);
  assert.equal(real[0].date, "2026-10-02");
  assert.equal(real[0].y10, 2.92);
  assert.equal(real.length, 2);
});

test("10y breakeven = nominal − real on the same date", () => {
  const data = buildBondsData(NOMINAL, REAL, null);
  assert.equal(breakeven10y(data.latest, data.real), Math.round((5.28 - 2.92) * 100) / 100); // 2.36
  // a date present in nominal but absent in real → null, not a stale pair
  assert.equal(breakeven10y({ date: "2026-09-30", y10: 5.29 }, data.real), null);
});

test("buildBondsData assembles asOf/latest/effr", () => {
  const effr = { date: "2026-10-01", rate: 3.88, targetFrom: 3.75, targetTo: 4.0 };
  const data = buildBondsData(NOMINAL, REAL, effr);
  assert.equal(data.asOf, "2026-10-02");
  assert.equal(data.latest?.y10, 5.28);
  assert.equal(data.effr?.rate, 3.88);
  assert.equal(data.curve.length, 3);
});

/* --- CNBC delayed intraday curve --- */
import { parseCnbcQuotes } from "../lib/bonds.ts";

const CNBC_PAYLOAD = {
  FormattedQuoteResult: {
    FormattedQuote: [
      { symbol: "US3M", last: "4.103%", last_time: "2026-10-02T17:05:00.000-0400" },
      { symbol: "US2Y", last: "4.827%", last_time: "2026-10-02T17:05:00.000-0400" },
      { symbol: "US10Y", last: "5.273%", last_time: "2026-10-02T17:05:00.000-0400" },
      { symbol: "US30Y", last: "5.623%", last_time: "2026-10-02T17:05:00.000-0400" },
      { symbol: "DE10Y", last: "2.10%", last_time: "2026-10-02T17:05:00.000-0400" },
    ],
  },
};

test("CNBC quotes: tenors mapped, % stripped, timestamp kept", () => {
  const c = parseCnbcQuotes(CNBC_PAYLOAD);
  assert.notEqual(c, null);
  assert.equal(c.m3, 4.103);
  assert.equal(c.y2, 4.827);
  assert.equal(c.y10, 5.273);
  assert.equal(c.y30, 5.623);
  assert.equal(c.m1, null); // not in payload
  assert.equal(c.asOf, "2026-10-02T17:05:00.000-0400");
});

test("CNBC quotes: non-finite or missing last → null tenor; <2 hits → null curve", () => {
  assert.equal(parseCnbcQuotes(null), null);
  assert.equal(parseCnbcQuotes({ FormattedQuoteResult: { FormattedQuote: [] } }), null);
  assert.equal(parseCnbcQuotes({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "US10Y", last: "n/a" }] } }), null);
  const c = parseCnbcQuotes({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "US10Y", last: "5.27%" }, { symbol: "US2Y", last: "4.8%" }] } });
  assert.equal(c.y10, 5.27);
  assert.equal(c.y2, 4.8);
});
