/* Seamless live blend: collected minutes continued by live tick minutes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blendLiveMinutes } from "../lib/footprint.ts";

// a collected ETH day ends at 15:59 feed (= 16:59 New York) on 2026-09-25
const hist = Array.from({ length: 6 }, (_, i) => ({
  t: `${String(15).padStart(2, "0")}:${String(54 + i).padStart(2, "0")}`, // 15:54..15:59
  d: "2026-09-25",
  high: 100 + i, low: 99 + i, buy: 10, sell: 5, delta: 5, live: false,
}));

const liveMinute = (utcHHmm, levels = {}) => ({
  t: utcHHmm, o: 101, h: 101.5, l: 100.5, c: 101, vol: 10, buy: 6, sell: 4,
  live: true, levels,
});

test("live minutes after the session end are appended, re-keyed to the feed clock with their day", () => {
  // 2026-09-25 is EDT: 21:00 UTC = 17:00 New York = 16:00 feed (post-close halt minute)
  const out = blendLiveMinutes(hist, [liveMinute("21:00"), liveMinute("21:01")], "2026-09-25");
  assert.equal(out.length, 8);
  assert.equal(out[6].t, "16:00", "UTC 21:00 → feed 16:00");
  assert.equal(out[6].d, "2026-09-25");
  assert.equal(out[7].t, "16:01");
  assert.equal(out[6].live, false, "blended bars are feed-keyed, chart treats them like collected");
});

test("overlapping/stale live minutes (before the last collected minute) are dropped", () => {
  // 19:59 UTC = 15:59 New York = 14:59 feed — already inside the collected window
  const out = blendLiveMinutes(hist, [liveMinute("19:59"), liveMinute("20:30"), liveMinute("21:00")], "2026-09-25");
  assert.equal(out.length, 7, "only the one post-session minute survives");
  assert.equal(out[6].t, "16:00");
});

test("the snapshot's placeholder minute (t=\"now\") never reaches the blend", () => {
  const out = blendLiveMinutes(hist, [{ ...liveMinute("now"), t: "now" }], "2026-09-25");
  assert.equal(out.length, 6);
});

test("blend crosses midnight correctly (winter: UTC → feed is -6h)", () => {
  // 2026-12-15 is EST: 23:30 UTC = 18:30 NY = 17:30 feed, on the SAME day
  const out = blendLiveMinutes(hist, [liveMinute("23:30")], "2026-12-15");
  assert.equal(out[6].t, "17:30", "EST uses -5h to NY then -1h to feed");
  assert.equal(out[6].d, "2026-12-15");
});

test("UTC-midnight rollover: each live bar uses its OWN date, not 'today'", () => {
  // 23:50Z on the 27th = 19:50 New York (EDT, -4) = 18:50 feed, still the 27th
  const before = blendLiveMinutes(hist, [{ ...liveMinute("23:50"), du: "2026-09-27" }], "2026-09-28");
  assert.equal(before[6].t, "18:50");
  assert.equal(before[6].d, "2026-09-27", "the bar belongs to the 27th, not to 'today' (the 28th)");
  // 00:10Z on the 28th = 20:10 New York on the 27th = 19:10 feed on the 27th
  const after = blendLiveMinutes(hist, [{ ...liveMinute("00:10"), du: "2026-09-28" }], "2026-09-28");
  assert.equal(after[6].t, "19:10");
  assert.equal(after[6].d, "2026-09-27", "00:10Z on the 28th is still the 27th in Chicago");
});

test("the collected minutes pass through untouched", () => {
  const out = blendLiveMinutes(hist, [], "2026-09-25");
  assert.deepEqual(out, hist);
});
