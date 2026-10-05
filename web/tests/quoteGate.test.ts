import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteAgreeDecision, parseYahooChartQuote } from "../lib/quoteGate";

test("quoteAgreeDecision: agrees inside the band, diverges beyond it, null is nodata", () => {
  // within the 3-pt band → ok (normal tape noise)
  assert.equal(quoteAgreeDecision(31141.5, 31141.0, 3), "ok");
  assert.equal(quoteAgreeDecision(31144.0, 31141.0, 3), "ok"); // exactly at the edge
  // the 2026-10-04 reopen: tape 31141 vs broker 31155 → refuse
  assert.equal(quoteAgreeDecision(31155.75, 31141.0, 3), "diverge");
  assert.equal(quoteAgreeDecision(31127.0, 31141.0, 3), "diverge"); // below too
  // unreadable quote (streaming client down) → policy decides, not the gate
  assert.equal(quoteAgreeDecision(null, 31141.0, 3), "nodata");
  assert.equal(quoteAgreeDecision(Number.NaN, 31141.0, 3), "nodata");
});

test("parseYahooChartQuote: fresh CME print accepted, stale/missing rejected", () => {
  const now = 1_791_206_000_000; // fixed epoch ms
  const chart = (price: unknown, t: unknown) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: t } }] } });
  assert.equal(parseYahooChartQuote(chart(31019.75, now / 1000), now), 31019.75);
  // 10 min old = at the edge, still accepted; 11 min = too stale
  assert.equal(parseYahooChartQuote(chart(31019.75, now / 1000 - 600), now), 31019.75);
  assert.equal(parseYahooChartQuote(chart(31019.75, now / 1000 - 601), now), null);
  // garbage payloads
  assert.equal(parseYahooChartQuote(null, now), null);
  assert.equal(parseYahooChartQuote({}, now), null);
  assert.equal(parseYahooChartQuote(chart(0, now / 1000), now), null);
  assert.equal(parseYahooChartQuote(chart("n/a", now / 1000), now), null);
});
