/* Pullback / trend-continuation signal regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPullback } from "../lib/pullback.ts";

const mins = (n, start = "10:00") =>
  Array.from({ length: n }, (_, i) => {
    const h = 10 + Math.floor((i + Number(start.slice(3))) / 60);
    const m = (Number(start.slice(3)) + i) % 60;
    return { t: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, high: 100.5, low: 99.5, delta: 0 };
  });
const base = (over = {}) => ({
  minutes: mins(20),
  lastPrice: 100,
  vwap: 99,
  poc: { label: "P0 POC", p: 100 },
  sessionHigh: 102,
  sessionLow: 98,
  imbalance: null,
  newsWin: false,
  ...over,
});
const ing = (r, k) => r.ingredients.find((x) => x.key === k);

test("an uptrend retest with a buy stack reads as a long pullback", () => {
  const m = mins(20);
  const last = m[m.length - 1].t;
  const r = readPullback(base({
    minutes: m,
    lastPrice: 100,
    imbalance: {
      buyRows: 3, sellRows: 0, dBuyRows: 3, dSellRows: 0, stackedMinutes: 1,
      stacks: [{ t: last, side: "buy", from: 99.5, to: 100, len: 3 }],
      lastStack: { t: last, side: "buy", from: 99.5, to: 100, len: 3 },
      lastMinute: null,
    },
  }));
  assert.equal(r.side, "long");
  assert.equal(r.tone, "long");
  assert.match(r.verdict, /PULLBACK LONG/);
  assert.equal(r.ingredients.filter((i) => i.state === "yes").length, 3, "all three required met");
  assert.ok(r.trigger.length > 0 && r.invalidation.length > 0 && r.target.length > 0);
});

test("the bearish mirror reads short", () => {
  const m = mins(20);
  const last = m[m.length - 1].t;
  const r = readPullback(base({
    minutes: m,
    lastPrice: 100,
    vwap: 101,
    imbalance: {
      buyRows: 0, sellRows: 3, dBuyRows: 0, dSellRows: 3, stackedMinutes: 1,
      stacks: [{ t: last, side: "sell", from: 100, to: 100.5, len: 3 }],
      lastStack: { t: last, side: "sell", from: 100, to: 100.5, len: 3 },
      lastMinute: null,
    },
  }));
  assert.equal(r.side, "short");
  assert.equal(r.tone, "short");
  assert.match(r.verdict, /PULLBACK SHORT/);
});

test("retest without a footprint trigger is forming, not a signal", () => {
  const r = readPullback(base({ imbalance: null }));
  assert.notEqual(r.tone, "long");
  assert.notEqual(r.tone, "short");
  assert.equal(ing(r, "trend").state, "yes");
  assert.equal(ing(r, "retest").state, "yes");
  assert.equal(ing(r, "trigger").state, "no");
});

test("no VWAP reference means no trend bias", () => {
  const r = readPullback(base({ vwap: 0 }));
  assert.equal(r.side, null);
  assert.equal(ing(r, "trend").state, "no");
  assert.match(r.verdict, /NO PULLBACK/);
});

test("too few bars degrade gracefully", () => {
  const r = readPullback(base({ minutes: mins(3) }));
  assert.equal(r.tone, "neutral");
  assert.match(r.verdict, /not enough bars/);
  assert.equal(r.ingredients.length, 0);
});
