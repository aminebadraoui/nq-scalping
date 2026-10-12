/* Unit tests for the live detector/footprint memoization
 * (lib/detectorCache.ts): memoized outputs must be identical to fresh
 * computation, stable keys return the same reference, and a bars-revision
 * bump invalidates. The archive-wide equivalence is checked by
 * scripts/detectorCacheValidation.ts. */
import { test } from "node:test";
import assert from "node:assert";
import {
  cachedFootprint,
  detectMomentumMemo,
  detectExpansionScalpMemo,
  detectSoftMomentumMemo,
  detectOpenDriveMemo,
} from "../lib/detectorCache";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import type { FootprintMinute } from "../lib/gcdata";
import type { LiveMinute } from "../lib/live";

/** a synthetic 60-bar session: quiet volume ramp so the detectors run */
function mkFp(n = 60): FootprintMinute[] {
  const out: FootprintMinute[] = [];
  for (let i = 0; i < n; i++) {
    const base = 20000 + i * 2;
    out.push({
      t: `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      d: "2026-10-11",
      o: base,
      c: base + 1,
      high: base + 2,
      low: base - 1,
      buy: 100 + i,
      sell: 90 + i,
      delta: 10,
      vwap: base,
      levels: [],
      imb: { buy: 0, sell: 0, dBuy: 0, dSell: 0, stacked: null, biased: null },
      src: "candle",
    });
  }
  return out;
}

const eq = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b));

test("detector memos: output identical to fresh, stable reference, revision invalidates", () => {
  const fp = mkFp();
  const cases: Array<{ name: string; memo: (rev: number) => unknown; fresh: () => unknown }> = [
    { name: "momentum", memo: (rev) => detectMomentumMemo(fp, MOM_PROD, rev), fresh: () => detectMomentum(fp, MOM_PROD) },
    { name: "expansion", memo: (rev) => detectExpansionScalpMemo(fp, EXP_PROD, rev), fresh: () => detectExpansionScalp(fp, EXP_PROD) },
    { name: "soft", memo: (rev) => detectSoftMomentumMemo(fp, SOFT_PROD, rev), fresh: () => detectSoftMomentum(fp, SOFT_PROD) },
    { name: "open", memo: (rev) => detectOpenDriveMemo(fp, OPEN_PROD, rev), fresh: () => detectOpenDrive(fp, OPEN_PROD) },
  ];
  for (const c of cases) {
    eq(c.memo(0), c.fresh());
    assert.strictEqual(c.memo(0), c.memo(0)); // stable key → same object
    const bumped = c.memo(12345);
    assert.notStrictEqual(bumped, c.memo(0)); // revision bump → recompute
    eq(bumped, c.fresh()); // …and the recompute stays identical
  }
});

test("detector memos: a changed tail bar invalidates (same length, same revision)", () => {
  const fp = mkFp();
  const a = detectMomentumMemo(fp, MOM_PROD, 7);
  fp[fp.length - 1].buy += 500; // vendor revision of the tail
  fp[fp.length - 1].sell += 40;
  const b = detectMomentumMemo(fp, MOM_PROD, 7);
  assert.notStrictEqual(a, b);
  eq(b, detectMomentum(fp, MOM_PROD));
});

test("cachedFootprint: same buffer+revision → same array; revision bump → fresh", () => {
  const liveMins: LiveMinute[] = mkFp().map((m) => ({
    t: m.t,
    du: m.d,
    o: m.o,
    h: m.high,
    l: m.low,
    c: m.c,
    vol: m.buy + m.sell,
    buy: m.buy,
    sell: m.sell,
    live: true,
    source: "candle",
  }));
  const f1 = cachedFootprint(liveMins, 0);
  assert.strictEqual(cachedFootprint(liveMins, 0), f1);
  assert.notStrictEqual(cachedFootprint(liveMins, 1), f1);
  // the developing bar (cur) is appended to a FRESH array, never cached
  const withCur = cachedFootprint(liveMins, 0, { ...liveMins[0], t: "23:59", live: false });
  assert.equal(withCur.length, f1.length + 1);
  assert.notStrictEqual(withCur, f1);
});
