/* Reversal checklist (mechanism) regression tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readMechanism } from "../lib/mechanism.ts";
import * as gc from "../lib/gcdata.ts";
import { DATE } from "./helpers.mjs";

const mins = (n, start = "10:00") =>
  Array.from({ length: n }, (_, i) => {
    const h = 10 + Math.floor((i + Number(start.slice(3))) / 60);
    const m = (Number(start.slice(3)) + i) % 60;
    return { t: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, high: 100.5, low: 99.5, delta: 0 };
  });
const base = (over = {}) => ({
  minutes: mins(40),
  lastPrice: 100,
  vwap: 100,
  absorption: [],
  alerts: [],
  reclaims: [],
  imbalance: null,
  lvnEdges: [],
  poc: null,
  sessionHigh: 101,
  sessionLow: 99,
  newsWin: false,
  ...over,
});
const ing = (r, k) => r.ingredients.find((x) => x.key === k);

test("a complete long sequence reads as a long mechanism", () => {
  const m = mins(40);
  m[37] = { t: m[37].t, high: 100.5, low: 99.0, delta: -50 };
  m[38] = { t: m[38].t, high: 100.2, low: 98.8, delta: -50 };
  m[39] = { t: m[39].t, high: 100.4, low: 99.4, delta: 60 };
  const r = readMechanism(base({
    minutes: m,
    absorption: [{ t: m[37].t, price: 99.2, side: "bid", bias: "bull", volume: 500, imbalance: 0.8 }],
    alerts: [{ t: m[38].t, kind: "DIVERGENCE_D2", price: 98.8, bias: "bull" }],
    reclaims: [{ t: m[39].t, price: 98.8, dir: "low" }],
    imbalance: { buyRows: 3, sellRows: 0, dBuyRows: 3, dSellRows: 0, stackedMinutes: 1, stacks: [], lastStack: { t: m[39].t, side: "buy", from: 99, to: 99.5, len: 3 }, lastMinute: null },
    lvnEdges: [{ label: "P0", p: 100, zone: "99.50–100.50" }],
    poc: { label: "P0 POC", p: 108 },
  }));
  assert.equal(r.side, "long");
  assert.equal(r.tone, "long");
  assert.equal(r.ingredients.filter((i) => i.role === "required").every((i) => i.state === "yes"), true, "all required met");
  assert.match(r.verdict, /LONG/);
  assert.ok(r.trigger.length > 0 && r.invalidation.length > 0 && r.target.length > 0);
});

test("the bearish mirror reads short", () => {
  const m = mins(40);
  m[37] = { t: m[37].t, high: 101.0, low: 99.5, delta: 50 };
  m[38] = { t: m[38].t, high: 101.2, low: 99.8, delta: 50 };
  m[39] = { t: m[39].t, high: 100.6, low: 99.6, delta: -60 };
  const r = readMechanism(base({
    minutes: m,
    absorption: [{ t: m[37].t, price: 100.8, side: "ask", bias: "bear", volume: 500, imbalance: 0.8 }],
    alerts: [{ t: m[38].t, kind: "DIVERGENCE_D4", price: 101.2, bias: "bear" }],
    reclaims: [{ t: m[39].t, price: 101.2, dir: "high" }],
    imbalance: { buyRows: 0, sellRows: 3, dBuyRows: 0, dSellRows: 3, stackedMinutes: 1, stacks: [], lastStack: { t: m[39].t, side: "sell", from: 100, to: 100.5, len: 3 }, lastMinute: null },
    poc: { label: "P0 POC", p: 95 },
  }));
  assert.equal(r.side, "short");
  assert.match(r.verdict, /SHORT/);
});

test("absorption aging: fresh = yes, stale = partial, old = no", () => {
  const make = (ageBars) => {
    const m = mins(40);
    const i = 39 - ageBars;
    return readMechanism(base({
      minutes: m,
      absorption: [{ t: m[i].t, price: 99.2, side: "bid", bias: "bull", volume: 500, imbalance: 0.8 }],
    }));
  };
  assert.equal(ing(make(10), "mechanism").state, "yes");
  assert.equal(ing(make(20), "mechanism").state, "partial");
  assert.equal(ing(make(35), "mechanism").state, "no");
});

test("no absorption always explains the missing invalidation level", () => {
  const r = readMechanism(base());
  assert.equal(ing(r, "mechanism").state, "no");
  assert.match(r.invalidation, /no absorption price to lean on/);
});

test("empty or NaN minutes never leak Infinity/NaN", () => {
  for (const minutes of [[], [{ t: "10:00", high: NaN, low: NaN, delta: NaN }]]) {
    const r = readMechanism(base({ minutes }));
    assert.ok(!/∞|Infinity|NaN/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
    assert.match(r.trigger, /no bars in the visible window/);
  }
});

test("a genuine tie with no required evidence is not silently long", () => {
  const m = mins(40);
  const r = readMechanism(base({
    minutes: m,
    absorption: [],
    reclaims: [{ t: m[39].t, price: 99.8, dir: "high" }],       // bear +1
    alerts: [{ t: m[38].t, kind: "DIVERGENCE_D2", price: 98.8, bias: "bull" }], // bull +1
    imbalance: null,
  }));
  assert.notEqual(r.side, "long", "1-1 tie without shared evidence must not default to long");
  assert.match(r.verdict, /NO MECHANISM|INTEREST|FORMING/);
});

test("a stale (partial) stack still establishes a side", () => {
  const m = mins(40);
  const r = readMechanism(base({
    minutes: m,
    imbalance: { buyRows: 3, sellRows: 0, dBuyRows: 3, dSellRows: 0, stackedMinutes: 1, stacks: [], lastStack: { t: m[20].t, side: "buy", from: 99, to: 99.5, len: 3 }, lastMinute: null },
  }));
  assert.equal(r.side, "long");
  assert.equal(ing(r, "evidence").state, "partial");
});

test("`missing` lists exactly the ingredients that are not 'yes'", () => {
  const r = readMechanism(base({ alerts: [{ t: mins(40)[38].t, kind: "DIVERGENCE_D2", price: 98.8, bias: "bull" }] }));
  const notYes = r.ingredients.filter((i) => i.state !== "yes").map((i) => i.name);
  assert.equal(r.missing.length, notYes.length);
  for (const n of notYes) assert.ok(r.missing.some((m) => m.startsWith(n)), `${n} listed`);
});

test("real session golden read", async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  const an = await gc.analyze(DATE, "RTH", undefined, undefined, 2);
  const r = readMechanism({
    minutes: fp.minutes.map((m) => ({ t: m.t, high: m.high, low: m.low, delta: m.delta })),
    lastPrice: fp.minutes.at(-1).c,
    vwap: an.vwap,
    absorption: an.absorption,
    alerts: an.alerts,
    reclaims: an.reclaims,
    imbalance: an.imbalance,
    lvnEdges: [],
    poc: { label: "P0 POC", p: an.stats.poc },
    sessionHigh: Math.max(...fp.minutes.map((m) => m.high)),
    sessionLow: Math.min(...fp.minutes.map((m) => m.low)),
    newsWin: false,
  });
  assert.equal(r.present, 3);
  assert.equal(r.side, "long");
  assert.match(r.verdict, /LONG INTEREST/);
  assert.equal(r.ingredients.map((i) => i.state[0]).join(""), "npynyy");
});

test("live bars are rewritable into the feed clock (the live-checklist regression)", async () => {
  const { toFeedClock } = await import("../lib/footprint.ts");
  const { utcToFeed } = await import("../lib/times.ts");
  const fp = await gc.extractFootprint(DATE, "RTH");
  const an = await gc.analyze(DATE, "RTH", undefined, undefined, 2);
  const feedMinutes = fp.minutes.map((m) => ({ t: m.t, high: m.high, low: m.low, delta: m.delta }));
  // what live ticks produce: the same bars keyed in UTC (+5h on this date)
  const shift = (t) => {
    const [h, m] = t.split(":").map(Number);
    const tot = (h * 60 + m + 300) % 1440;
    return `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(tot % 60).padStart(2, "0")}`;
  };
  const liveMinutes = feedMinutes.map((m) => ({ ...m, t: shift(m.t), live: true }));

  const args = (minutes) => ({
    minutes, lastPrice: feedMinutes.at(-1).high, vwap: an.vwap,
    absorption: an.absorption, alerts: an.alerts, reclaims: an.reclaims, imbalance: an.imbalance,
    lvnEdges: [], poc: null,
    sessionHigh: Math.max(...feedMinutes.map((m) => m.high)), sessionLow: Math.min(...feedMinutes.map((m) => m.low)),
    newsWin: false,
  });
  const collected = readMechanism(args(feedMinutes));
  const rawLive = readMechanism(args(liveMinutes));
  const fixedLive = readMechanism(args(toFeedClock(liveMinutes)));

  assert.ok(rawLive.present < collected.present, "raw UTC keys lose ingredients (the original bug)");
  assert.equal(fixedLive.present, collected.present, "normalizing restores the read");
  assert.equal(fixedLive.side, collected.side);
  assert.equal(fixedLive.ingredients.map((i) => i.state).join(""), collected.ingredients.map((i) => i.state).join(""));
  // and the helper is exactly the documented conversion
  assert.equal(toFeedClock([{ t: "13:30", live: true }])[0].t, utcToFeed("13:30"));
  assert.equal(toFeedClock([{ t: "08:30", live: false }])[0].t, "08:30", "collected bars are untouched");
});

test("a nearby gamma wall counts as partial location (coarse dealer zone)", () => {
  const m = mins(40);
  const r = readMechanism(base({
    minutes: m,
    lastPrice: 100,
    sessionHigh: 150,
    sessionLow: 50,
    walls: [{ kind: "call", p: 105 }],
  }));
  assert.equal(ing(r, "location").state, "partial");
  assert.match(ing(r, "location").short, /call wall/);
});

test("an LVN edge beats a wall for the tick-precise location", () => {
  const m = mins(40);
  const r = readMechanism(base({
    minutes: m,
    lastPrice: 100,
    walls: [{ kind: "put", p: 110 }],
    lvnEdges: [{ label: "P0", p: 100, zone: "99.50–100.50" }],
  }));
  assert.equal(ing(r, "location").state, "yes");
  assert.match(ing(r, "location").short, /LVN edge/);
});
