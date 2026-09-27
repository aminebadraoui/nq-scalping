/* OHLC data integrity, the OHLC<->footprint join, and the overnight mapping. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATA, loadDay, loadOhlc, DATE } from "./helpers.mjs";
import { feedToEpoch, fmtETTime } from "../lib/times.ts";
import { extractFootprint } from "../lib/gcdata.ts";

const files = existsSync(path.join(DATA, "ohlc"))
  ? readdirSync(path.join(DATA, "ohlc")).filter((f) => f.endsWith(".json")).sort()
  : [];
const footprintDates = readdirSync(DATA).filter((f) => /^\d{4}-\d{2}-\d{2}_RTH\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();

test("every OHLC file is structurally valid", () => {
  assert.ok(files.length > 0, "at least one OHLC file");
  for (const f of files) {
    const bars = JSON.parse(readFileSync(path.join(DATA, "ohlc", f), "utf8")).bars ?? [];
    assert.ok(bars.length > 0, `${f} has bars`);
    const seen = new Set();
    for (const b of bars) {
      assert.ok(b.l <= b.o && b.o <= b.h, `${f} ${b.t}: low <= open <= high`);
      assert.ok(b.l <= b.c && b.c <= b.h, `${f} ${b.t}: low <= close <= high`);
      assert.ok(b.v > 0, `${f} ${b.t}: volume > 0`);
      assert.ok(!seen.has(b.t), `${f} ${b.t}: duplicate minute`);
      seen.add(b.t);
    }
    const sorted = bars.map((b) => b.t);
    assert.deepEqual(sorted, [...sorted].sort(), `${f} is chronologically sorted`);
  }
});

test("every date that has footprint data has a COMPLETE 390-bar RTH OHLC file", () => {
  assert.ok(footprintDates.length >= 5, `${footprintDates.length} footprint dates`);
  for (const d of footprintDates) {
    const bars = loadOhlc(d);
    assert.ok(bars, `${d} has an OHLC file`);
    assert.equal(bars.length, 390, `${d} has 390 one-minute bars`);
  }
});

test("every OHLC minute matches the footprint candle exactly (price and volume)", () => {
  let joined = 0;
  for (const d of footprintDates) {
    const bars = new Map((loadOhlc(d) ?? []).map((b) => [b.t.slice(11, 16), b]));
    for (const session of ["RTH", "ETH"]) {
      const candles = loadDay(d, session) ?? [];
      for (const c of candles) {
        const b = bars.get(c.t.slice(11, 16));
        if (!b) continue;
        joined++;
        assert.equal(b.h, c.high / 100, `${d} ${session} ${c.t} high`);
        assert.equal(b.l, c.low / 100, `${d} ${session} ${c.t} low`);
        assert.equal(b.v, c.total, `${d} ${session} ${c.t} volume`);
      }
    }
  }
  assert.ok(joined >= 3900, `joined ${joined} minutes`);
});

test("price scaling is /100 (a missing division would show ~3,000,000)", () => {
  const bars = loadOhlc(DATE);
  const hi = Math.max(...bars.map((b) => b.h));
  const lo = Math.min(...bars.map((b) => b.l));
  assert.ok(hi > 20000 && hi < 40000, `high ${hi} is a plausible NQ price`);
  assert.ok(lo > 20000, `low ${lo}`);
});

test("the full-day ETH window maps to 1380 contiguous minutes across midnight", async () => {
  const fp = await extractFootprint(DATE, "ETH");
  assert.equal(fp.minutes.length, 1380);
  const dates = new Set(fp.minutes.map((m) => m.d));
  assert.equal(dates.size, 2, "the overnight session spans two calendar dates");
  const epochs = fp.minutes.map((m) => feedToEpoch(m.t, m.d));
  for (let i = 1; i < epochs.length; i++) {
    assert.equal(epochs[i] - epochs[i - 1], 60, `bar ${i} follows the previous one by one minute`);
  }
  assert.equal(fmtETTime(epochs[0]), "18:00", "session opens 18:00 New York");
  assert.equal(fmtETTime(epochs[epochs.length - 1]), "16:59", "session ends 16:59 New York");
});

test("the three session windows return the documented bar counts", async () => {
  const rth = await extractFootprint(DATE, "RTH");
  const post = await extractFootprint(DATE, "ETH", "08:30", "15:59");
  const full = await extractFootprint(DATE, "ETH");
  assert.equal(rth.minutes.length, 390);
  assert.equal(post.minutes.length, 450, "09:30-16:59 New York (the GoCharting chart window)");
  assert.equal(full.minutes.length, 1380);
  const ny = (m) => fmtETTime(feedToEpoch(m.t, m.d));
  assert.equal(ny(post.minutes[0]), "09:30");
  assert.equal(ny(post.minutes.at(-1)), "16:59");
});
