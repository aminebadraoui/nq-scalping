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

/**
 * The file store now holds everything the vendor would return, and the vendor
 * THINS old history rather than truncating it: 210 of 221 collected sessions
 * come back with minutes missing from the middle and no OHLC counterpart,
 * because OHLC was only collected for the days that mattered.
 *
 * Those partial sessions are excluded from every analysis path (see
 * lib/lab.ts discoverCompleteSessions and db/study.ts), so integrity guarantees
 * only mean something for the sessions the system actually reads. Scope the
 * coverage/parity assertions to those, and keep them strict for them.
 */
const COMPLETE_MINUTES = 1380;

function isComplete(date) {
  try {
    const j = JSON.parse(readFileSync(path.join(DATA, `${date}_ETH.json`), "utf8"));
    // the pipeline's own verdict (_meta.kind) — a merged holiday payload can
    // have >1380 minutes without being a usable session, so count alone lies
    return j._meta?.kind === "complete" || (j.candles ?? []).length === COMPLETE_MINUTES;
  } catch {
    return false;
  }
}

const authoritativeDates = footprintDates.filter(isComplete);

/** Dates that have a vendor OHLC twin on disk. OHLC is only collected for the
 *  recent window (collect_ohlc --windows), so older complete sessions are
 *  footprint-only by design — assertions about twins apply to these dates. */
const ohlcDates = new Set(files.map((f) => f.slice(0, 10)));
const twinDates = authoritativeDates.filter((d) => ohlcDates.has(d));

/**
 * One partial session is known-inconsistent and is deliberately quarantined:
 * 2026-09-08's footprint disagrees with OHLC on 64 of 702 overlapping minutes
 * (high, low and volume). Every other collected date agrees exactly, including
 * all 10 complete ones, so this is not a systematic collection bug. The nightly
 * job re-fetches partial sessions, so it will be retried; until it agrees it
 * must never be used for analysis.
 */
const QUARANTINED = ["2026-09-08"];

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

test("every COMPLETE session with an OHLC twin has a full 390-bar RTH file", () => {
  assert.ok(twinDates.length >= 5, `${twinDates.length} complete sessions with OHLC twins`);
  for (const d of twinDates) {
    const bars = loadOhlc(d);
    assert.ok(bars, `${d} has an OHLC file`);
    assert.equal(bars.length, 390, `${d} has 390 one-minute bars`);
  }
});

test("complete sessions agree with their OHLC twin on every overlapping minute", () => {
  let joined = 0;
  for (const d of twinDates) {
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
  // 10 complete sessions x 390 RTH minutes x (RTH + ETH) = 7800
  assert.ok(joined >= 3900, `joined ${joined} minutes`);
});

test("the quarantined partial session is not analysable", () => {
  // Guards against the quarantine above being quietly forgotten: if 2026-09-08
  // ever comes back complete, this fails so the exclusion gets re-examined
  // instead of persisting as folklore.
  for (const d of QUARANTINED) {
    assert.equal(isComplete(d), false, `${d} unexpectedly became complete — re-check its OHLC parity and un-quarantine it`);
  }
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
