/* ES join-layer tests — synthetic minutes, no network. The rules here are
 * re-derived from the docstrings in lib/esJoin.ts (flushAgreement,
 * breakdownVeto, esDeltaSign, rsBand) so a regression in the implementation
 * cannot make a test pass by definition. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEsContext, flushAgreement, breakdownVeto, esFreshExtreme, esDeltaSign, rsBand, esFrontMonth, esCardChips, type EsMinute } from "../lib/esJoin";

/* ---------------- builders ---------------- */


/** one ES minute: feed date 2026-10-01, times 17:00 + i minutes */
function esMinute(i: number, p: { high?: number; low?: number; buy?: number; sell?: number } = {}): EsMinute {
  const hh = String(17 + Math.floor(i / 60)).padStart(2, "0");
  const mm = String(i % 60).padStart(2, "0");
  const high = p.high ?? 6000 + i * 0.1;
  const low = p.low ?? high - 1;
  const buy = p.buy ?? 500;
  const sell = p.sell ?? 500;
  return { t: `${hh}:${mm}`, d: "2026-09-30", high, low, buy, sell, total: buy + sell, mid: (high + low) / 2 };
}

/** NQ minute with the same stamping convention */
function nqMinute(i: number, p: { high?: number; low?: number } = {}): { t: string; d: string; high: number; low: number } {
  const hh = String(17 + Math.floor(i / 60)).padStart(2, "0");
  const mm = String(i % 60).padStart(2, "0");
  const high = p.high ?? 20000 + i * 0.5;
  const low = p.low ?? high - 5;
  return { t: `${hh}:${mm}`, d: "2026-09-30", high, low };
}

function ctx(es: EsMinute[], nqN = 100): ReturnType<typeof buildEsContext> {
  return buildEsContext(
    Array.from({ length: nqN }, (_, i) => nqMinute(i)),
    es,
  );
}

/* ---------------- alignment ---------------- */

test("aligns by feed timestamp and flags missing minutes", () => {
  const es = [esMinute(0), esMinute(2), esMinute(3)];
  const c = ctx(es, 5);
  assert.equal(c.ok[0], true);
  assert.equal(c.ok[1], false, "no ES twin for minute 1");
  assert.equal(c.ok[2], true);
  assert.equal(c.ok[3], true);
  assert.equal(c.ok[4], false);
  assert.equal(c.missing, 2);
});

test("cumulative delta and running extremes are no-lookahead", () => {
  const es = [
    esMinute(0, { buy: 700, sell: 300 }), // delta +400
    esMinute(1, { buy: 100, sell: 900 }), // delta -800
    esMinute(2, { high: 5999, low: 5998, buy: 500, sell: 500 }), // new session low
  ];
  const c = ctx(es, 3);
  assert.equal(c.delta[0], 400);
  assert.equal(c.cumDelta[1], -400, "running total, not future-aware");
  assert.equal(c.newLow[2], true, "printed a new session low at minute 2");
  assert.equal(c.newLow[0], false, "first bar defines the extreme, does not break it");
  assert.equal(c.sessionLow[2], 5998);
});

/* ---------------- flush agreement ---------------- */

test("agree: ES flushed the same side and held its own extreme", () => {
  // minute 5 = NQ flush bar k. ES minutes 3..5: one-sided sell bars, no new low.
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i >= 3 && i <= 5 ? { buy: 100, sell: 900 } : {}),
  );
  const c = ctx(es, 10);
  assert.equal(flushAgreement(c, 5, "long"), "agree");
});

test("diverge: ES printed a new session low while NQ held", () => {
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 4 ? { high: 5990, low: 5989, buy: 100, sell: 900 } : {}),
  );
  const c = ctx(es, 10);
  assert.equal(flushAgreement(c, 5, "long"), "diverge");
});

test("neutral: ES did not flush and did not break", () => {
  const es = Array.from({ length: 10 }, (_, i) => esMinute(i));
  const c = ctx(es, 10);
  assert.equal(flushAgreement(c, 5, "long"), "neutral");
});

test("short mirror: buy-flush agreement, new-high divergence", () => {
  const agree = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i >= 3 && i <= 5 ? { buy: 900, sell: 100 } : {}),
  );
  assert.equal(flushAgreement(ctx(agree, 10), 5, "short"), "agree");

  const diverge = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 4 ? { high: 6015, low: 6014, buy: 900, sell: 100 } : {}),
  );
  assert.equal(flushAgreement(ctx(diverge, 10), 5, "short"), "diverge");
});

/* ---------------- breakdown veto ---------------- */

test("veto: ES new session low within 5 bars before a long entry", () => {
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 6 ? { high: 5990, low: 5989 } : {}),
  );
  const c = ctx(es, 10);
  assert.equal(breakdownVeto(c, 8, "long"), true, "new low at 6 is inside [3,8]");
  assert.equal(breakdownVeto(c, 4, "long"), false, "new low at 6 is outside [−1,4]");
});

test("veto respects the trade direction (mirror)", () => {
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 6 ? { high: 6015, low: 6014 } : {}),
  );
  const c = ctx(es, 10);
  assert.equal(breakdownVeto(c, 8, "long"), false, "new HIGH does not veto a long");
  assert.equal(breakdownVeto(c, 8, "short"), true);
});

/* ---------------- delta sign ---------------- */

test("delta sign bands: ±100 flat threshold", () => {
  const es = [
    esMinute(0, { buy: 900, sell: 100 }), // +800
    esMinute(1, { buy: 100, sell: 900 }), // -800 -> cum 0 (flat)
    esMinute(2, { buy: 100, sell: 900 }), // cum -800 (neg)
    esMinute(3, { buy: 500, sell: 500 }), // cum -800
  ];
  const c = ctx(es, 4);
  assert.equal(esDeltaSign(c, 0), "pos");
  assert.equal(esDeltaSign(c, 1), "flat", "cum returns to zero -> flat");
  assert.equal(esDeltaSign(c, 2), "neg");
  const flat = [esMinute(0, { buy: 540, sell: 460 })]; // +80
  assert.equal(esDeltaSign(ctx(flat, 1), 0), "flat");
});

/* ---------------- rs band ---------------- */

test("rs band: strong when NQ gains on ES, weak when it loses", () => {
  const es = Array.from({ length: 70 }, (_, i) => esMinute(i, { high: 6000 + i * 0.1, low: 6000 + i * 0.1 - 1 }));
  // NQ rising faster than ES over the last ~10 bars -> spread widening -> strong
  const nq = Array.from({ length: 70 }, (_, i) => {
    const rise = i >= 60 ? (i - 59) * 10 : i * 0.4; // NQ accelerates hard after bar 60
    return { t: `17:${String(i % 60).padStart(2, "0")}`, d: "2026-09-30", high: 20000 + rise, low: 20000 + rise - 5 };
  });
  const c = buildEsContext(nq, es);
  assert.equal(rsBand(c, nq.map((m) => (m.high + m.low) / 2), 69), "strong");
  // mirrored: NQ collapsing vs stable ES -> weak
  const nq2 = nq.map((m, i) => ({ ...m, high: 20000 + (i >= 60 ? -(i - 59) * 10 : i * 0.4), low: 19995 + (i >= 60 ? -(i - 59) * 10 : i * 0.4) }));
  const c2 = buildEsContext(nq2, es);
  assert.equal(rsBand(c2, nq2.map((m) => (m.high + m.low) / 2), 69), "weak");
});

test("rs band: insufficient history -> neutral", () => {
  const es = Array.from({ length: 10 }, (_, i) => esMinute(i));
  const c = ctx(es, 10);
  const nqMid = Array.from({ length: 10 }, (_, i) => 20000 + i * 0.5);
  assert.equal(rsBand(c, nqMid, 9), "neutral");
});

/* ---------------- esFrontMonth ---------------- */

test("esFrontMonth follows the H/M/U/Z third-Friday calendar", () => {
  assert.equal(esFrontMonth(new Date("2026-10-05T12:00:00Z")), "ESZ26");
  assert.equal(esFrontMonth(new Date("2026-09-01T12:00:00Z")), "ESU26");
  assert.equal(esFrontMonth(new Date("2026-09-18T12:00:00Z")), "ESU26", "expiry day still front month");
  assert.equal(esFrontMonth(new Date("2026-09-19T12:00:00Z")), "ESZ26", "day after expiry rolls");
  assert.equal(esFrontMonth(new Date("2024-03-27T12:00:00Z")), "ESM24");
  assert.equal(esFrontMonth(new Date("2023-12-18T12:00:00Z")), "ESH24");
});

test("esFreshExtreme is the BROAD CONFIRM alias of breakdownVeto", () => {
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 6 ? { high: 5990, low: 5989 } : {}),
  );
  const c = ctx(es, 10);
  assert.equal(esFreshExtreme(c, 8, "long"), true);
  assert.equal(esFreshExtreme(c, 8, "long"), breakdownVeto(c, 8, "long"));
});

/* ---------------- live card chips ---------------- */

test("esCardChips: broad confirm labels and features", () => {
  const es = Array.from({ length: 10 }, (_, i) =>
    esMinute(i, i === 6 ? { high: 5990, low: 5989 } : {}),
  );
  const c = ctx(es, 10);
  const nqMid = Array.from({ length: 10 }, () => 20000);
  const out = esCardChips(c, nqMid, { dir: "long", flushIdx: 4, entryIdx: 8 }, true);
  assert.ok(out.labels.includes("ES CONFIRM 85%"));
  assert.equal(out.features.esBroadConfirm, true);
});

test("esCardChips: delta-negative short warning only for shorts", () => {
  const es = Array.from({ length: 10 }, (_, i) => esMinute(i, { buy: 100, sell: 900 }));
  const c = ctx(es, 10);
  const nqMid = Array.from({ length: 10 }, () => 20000);
  const shortOut = esCardChips(c, nqMid, { dir: "short", flushIdx: 5, entryIdx: 8 }, true);
  assert.ok(shortOut.labels.some((l) => l.startsWith("ES Δ−")));
  assert.equal(shortOut.features.esDeltaNegShort, true);
  const longOut = esCardChips(c, nqMid, { dir: "long", flushIdx: 5, entryIdx: 8 }, true);
  assert.ok(!longOut.features.esDeltaNegShort);
});

test("esCardChips: null context -> no chips", () => {
  const out = esCardChips(null, [], { dir: "long", flushIdx: 0, entryIdx: 0 }, true);
  assert.deepEqual(out.labels, []);
  assert.deepEqual(out.features, {});
});

test("esCardChips: includeDelta=false skips the flush delta chip", () => {
  const es = Array.from({ length: 10 }, (_, i) => esMinute(i, { buy: 100, sell: 900 }));
  const c = ctx(es, 10);
  const nqMid = Array.from({ length: 10 }, () => 20000);
  const out = esCardChips(c, nqMid, { dir: "short", flushIdx: 5, entryIdx: 8 }, false);
  assert.equal(out.features.esDelta, undefined);
  assert.ok(!out.labels.some((l) => l.startsWith("ES Δ−")));
});
