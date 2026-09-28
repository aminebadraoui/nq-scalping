/* Price-action (premium/discount) regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPriceAction, dealingRange, zoneOf, oteOf, TIMEFRAMES, MAX_SCORE } from "../lib/priceaction.ts";
import * as gc from "../lib/gcdata.ts";
import { DATE } from "./helpers.mjs";

/* uniform bars: low..high on every bar, so any trailing window is the same range */
const bars = (n, lo, hi) => Array.from({ length: n }, () => ({ high: hi, low: lo }));

test("zone classification: discount / equilibrium / premium around 50% ± 5%", () => {
  assert.equal(zoneOf(0.2), "discount");
  assert.equal(zoneOf(0.44), "discount"); // just inside the band edge
  assert.equal(zoneOf(0.47), "equilibrium");
  assert.equal(zoneOf(0.5), "equilibrium");
  assert.equal(zoneOf(0.53), "equilibrium");
  assert.equal(zoneOf(0.56), "premium"); // just outside the band edge
  assert.equal(zoneOf(0.8), "premium");
});

test("OTE bands are the 21.4–38.2% (long) and 61.8–78.6% (short) retracements", () => {
  assert.equal(oteOf(0.3), "long");
  assert.equal(oteOf(0.7), "short");
  assert.equal(oteOf(0.5), null);
  assert.equal(oteOf(0.1), null);
  assert.equal(oteOf(0.9), null);
});

test("six timeframes, weights sum to the documented max score of 12", () => {
  assert.equal(TIMEFRAMES.length, 6);
  assert.equal(TIMEFRAMES.map((t) => t.tf).join(","), "1d,4h,1h,15m,5m,1m");
  assert.equal(MAX_SCORE, 12);
  assert.equal(TIMEFRAMES.reduce((s, t) => s + t.weight, 0), 12);
});

test("all-discount reads long, all-premium reads short, with strict alignment", () => {
  const long = readPriceAction({ minutes: bars(300, 100, 200), lastPrice: 125, sessionHigh: 200, sessionLow: 100 });
  assert.equal(long.side, "long");
  assert.equal(long.aligned, "long");
  assert.equal(long.discountCount, 6);
  assert.equal(long.longScore, 12);

  const short = readPriceAction({ minutes: bars(300, 100, 200), lastPrice: 175, sessionHigh: 200, sessionLow: 100 });
  assert.equal(short.side, "short");
  assert.equal(short.aligned, "short");
  assert.equal(short.premiumCount, 6);
  assert.equal(short.shortScore, 12);
});

test("price at equilibrium everywhere reads mixed / no side", () => {
  const r = readPriceAction({ minutes: bars(300, 100, 200), lastPrice: 150, sessionHigh: 200, sessionLow: 100 });
  assert.equal(r.side, null);
  assert.equal(r.discountCount, 0);
  assert.equal(r.premiumCount, 0);
  assert.match(r.verdict, /MIXED LOCATION/);
});

test("a single dissenting timeframe removes strict alignment but keeps the weighted side", () => {
  // five timeframes see discount, the 1m window sees premium: a scattered dot
  const mins = bars(300, 100, 200);
  mins[mins.length - 1] = { high: 110, low: 104 }; // 1m range 104–110, price 125 → premium
  const r = readPriceAction({ minutes: mins, lastPrice: 125, sessionHigh: 200, sessionLow: 100 });
  assert.equal(r.discountCount, 5);
  assert.equal(r.premiumCount, 1);
  assert.equal(r.longScore, 11); // 1d+4h+1h+15m+5m
  assert.equal(r.shortScore, 1); // 1m
  assert.equal(r.side, "long", "weighted score still calls it long");
  assert.equal(r.aligned, null, "but the location is not strictly aligned");
});

test("dealing range uses the session high/low for daily and trailing bars below it", () => {
  const mins = bars(100, 100, 200);
  const d = dealingRange(mins, "1d", 210, 90);
  assert.deepEqual({ low: d.low, high: d.high }, { low: 90, high: 210 });

  const h = dealingRange(mins, "1h");
  assert.equal(h.low, 100);
  assert.equal(h.high, 200);
});

test("empty / flat / NaN input never leaks NaN or Infinity", () => {
  const cases = [
    { minutes: [], lastPrice: 0 },
    { minutes: bars(10, 100, 100), lastPrice: 100 }, // flat range
    { minutes: [{ high: NaN, low: NaN }], lastPrice: NaN },
    { minutes: [{ high: 200, low: 100 }], lastPrice: 0 }, // price falls back to last high
  ];
  for (const input of cases) {
    const r = readPriceAction(input);
    assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
    assert.equal(typeof r.side, r.side === null ? "object" : "string");
  }
});

test("real session golden read: no NaN, sane score, weighted sum bounded by 12", async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  const minutes = fp.minutes.map((m) => ({ high: m.high, low: m.low }));
  const sessionHigh = Math.max(...minutes.map((m) => m.high));
  const sessionLow = Math.min(...minutes.map((m) => m.low));
  const r = readPriceAction({
    minutes,
    lastPrice: fp.minutes.at(-1).c,
    sessionHigh,
    sessionLow,
  });
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)));
  assert.equal(r.maxScore, 12);
  assert.ok(r.longScore >= 0 && r.longScore <= 12);
  assert.ok(r.shortScore >= 0 && r.shortScore <= 12);
  assert.equal(r.longScore + r.shortScore <= 12, true, "equilibrium contributes to neither side");
  assert.ok(r.rows.every((row) => row.enough), "390 RTH bars fill every trailing window");
  assert.equal(r.rows[0].tf, "1d");
});
