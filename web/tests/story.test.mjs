/* Footprint story: the bar-state grammar, the relationship features and the
 * narrative. Fixtures pin the classifier; the real session pins the totals. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStory } from "../lib/story.ts";
import { cdtToET } from "../lib/times.ts";
import * as gc from "../lib/gcdata.ts";
import { DATE } from "./helpers.mjs";

const bar = (t, { o = 100, c = 100, h = 100.5, l = 99.5, buy = 50, sell = 50 } = {}) => ({
  t, o, c, high: h, low: l, buy, sell, delta: buy - sell, levels: [{ price: 100, buy, sell }],
});
/** 20 quiet bars, then the fixture bars under test */
function seriesWith(fixture) {
  const head = Array.from({ length: 20 }, (_, i) => bar(`10:${String(i).padStart(2, "0")}`));
  return [...head, ...fixture.map((b, i) => ({ ...b, t: `11:${String(i).padStart(2, "0")}` }))];
}
const lastState = (mins) => buildStory(mins, []).bars.at(-1).state;

test("classifier: a buying climax (big volume/range, closed off the high)", () => {
  const mins = seriesWith([
    bar("x", { buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 102, h: 110, l: 99, buy: 900, sell: 100 }),
  ]);
  assert.equal(lastState(mins), "CLIMAX_UP");
});

test("classifier: a selling climax (closed off the low)", () => {
  const mins = seriesWith([
    bar("x", { buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 98, h: 101, l: 90, buy: 100, sell: 900 }),
  ]);
  assert.equal(lastState(mins), "CLIMAX_DN");
});

test("classifier: a quiet retest / no-supply bar", () => {
  // narrow (<= half the median range of the last 20 bars), quieter than BOTH
  // prior bars, and touching the recent extreme without extending it
  const mins = seriesWith([
    bar("x", { o: 99, c: 101, h: 105, l: 99, buy: 300, sell: 300 }),
    bar("x", { o: 104, c: 104.2, h: 104.6, l: 104.2, buy: 5, sell: 5 }),
  ]);
  assert.equal(lastState(mins), "TEST");
});

test("classifier: a vacuum move (thin volume, wide range)", () => {
  const mins = seriesWith([
    bar("x", { o: 100, c: 102, h: 103, l: 100, buy: 200, sell: 200 }),
    bar("x", { o: 100, c: 102, h: 104, l: 100, buy: 20, sell: 20 }),
  ]);
  assert.equal(lastState(mins), "VACUUM");
});

test("classifier: plain rotation", () => {
  const mins = seriesWith([
    bar("x", { o: 100, c: 100.25, h: 100.5, l: 99.5, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 100.25, h: 100.5, l: 99.5, buy: 50, sell: 50 }),
  ]);
  assert.equal(lastState(mins), "ROTATION");
});

test("regression: a big bar with NO new extreme is not initiative", () => {
  const mins = seriesWith([
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    // 1000 contracts, +25% delta, but the high/low stay inside the 3-bar extremes
    bar("x", { o: 100, c: 100, h: 105, l: 95, buy: 625, sell: 375 }),
  ]);
  assert.equal(lastState(mins), "ROTATION", "initiative needs aggression AND a new extreme");
});

test("regression: initiative still fires with a new extreme", () => {
  const mins = seriesWith([
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 100, h: 110, l: 90, buy: 50, sell: 50 }),
    bar("x", { o: 100, c: 111, h: 112, l: 100, buy: 625, sell: 375 }),
  ]);
  assert.equal(lastState(mins), "INITIATIVE_UP");
});

test("degenerate inputs return null instead of throwing", () => {
  assert.equal(buildStory([], []), null);
  assert.equal(buildStory([bar("10:00"), bar("10:01"), bar("10:02")], []), null);
  const zeroVol = Array.from({ length: 10 }, (_, i) => bar(`10:${String(i).padStart(2, "0")}`, { buy: 0, sell: 0 }));
  assert.doesNotThrow(() => buildStory(zeroVol, []));
  assert.ok(!JSON.stringify(buildStory(zeroVol, [])).includes("NaN"));
});

test("real session: states, relationships and totals are pinned", async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  const an = await gc.analyze(DATE, "RTH", undefined, undefined, 2);
  const st = buildStory(fp.minutes, an.absorption, cdtToET);
  const allowed = ["INITIATIVE_UP", "INITIATIVE_DN", "CLIMAX_UP", "CLIMAX_DN", "TEST", "VACUUM", "ABSORPTION", "ROTATION"];
  for (const b of st.bars) assert.ok(allowed.includes(b.state), `${b.t} state ${b.state}`);

  const hist = {};
  for (const b of st.bars) hist[b.state] = (hist[b.state] ?? 0) + 1;
  assert.deepEqual(hist, { CLIMAX_DN: 9, ROTATION: 306, ABSORPTION: 24, CLIMAX_UP: 7, INITIATIVE_UP: 21, INITIATIVE_DN: 14, TEST: 9 });

  // transitions == consecutive state changes
  const want = [];
  for (let i = 1; i < st.bars.length; i++) if (st.bars[i].state !== st.bars[i - 1].state) want.push(st.bars[i].t);
  assert.deepEqual(st.transitions.map((x) => x.t), want);
  assert.equal(st.transitions.length, 149);

  assert.equal(st.pocTrail, "flat");
  assert.deepEqual(st.deltaFlip, { t: "14:03", dir: "up" });
  assert.deepEqual(st.effort, { t: "14:59", kind: "stall" });
});

test("real session: POC trail matches an independent recomputation", async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  const st = buildStory(fp.minutes, []);
  const pocs = fp.minutes.map((m) => m.levels.reduce((b, l) => (l.buy + l.sell > b.buy + b.sell ? l : b), m.levels[0]).price);
  let len = 0;
  let side = null;
  for (let i = pocs.length - 1; i >= 1; i--) {
    const s = Math.sign(Math.round((pocs[i] - pocs[i - 1]) * 4));
    if (s === 0) break;
    const sd = s > 0 ? "up" : "down";
    if (len === 0) side = sd;
    else if (sd !== side) break;
    len++;
  }
  assert.equal(st.pocTrail, len >= 3 ? side : "flat");
  assert.equal(st.pocTrailLen, len);
});

test("narrative times are formatted through the supplied formatter (New York)", async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  const an = await gc.analyze(DATE, "RTH", undefined, undefined, 2);
  const st = buildStory(fp.minutes, an.absorption, cdtToET);
  const times = [...st.narrative.matchAll(/\b\d\d:\d\d\b/g)].map((m) => m[0]);
  for (const t of times) assert.ok(t >= "09:30" && t <= "17:00", `narrative time ${t} looks like New York`);
  // a sentinel formatter proves the narrative never prints a raw feed clock
  const sentinel = buildStory(fp.minutes, an.absorption, (t) => `T${t.replace(":", "h")}`);
  assert.ok(!/\b\d\d:\d\d\b/.test(sentinel.narrative), "no HH:mm survives a non-time formatter");
});
