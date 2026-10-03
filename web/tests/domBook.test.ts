/* Unit tests for the DOM book + iceberg refill detector (lib/domBook.ts).
 * Fixtures replay the DOM_V2 message shapes decoded from the terminal's
 * trades.worker bundle (2026-10-02). */
import { test } from "node:test";
import assert from "node:assert";
import { DomBook, buildDomContext, compactCandidates, esSymbolFor, type DomIncrementalData, type IcebergCandidate } from "../lib/domBook";

const P = 30800; // price base, 0.25 ticks
const T0 = Date.parse("2026-10-05T13:30:00Z");
let ms = T0;

function snap(bid: [number, number][], ask: [number, number][] = []) {
  return { bids: bid.map(([p, s]) => ({ p: P + p * 0.25, s })), asks: ask.map(([p, s]) => ({ p: P + p * 0.25, s })) };
}

function incr(bids: { a?: string; p: number; s: number }[], asks: { a?: string; p: number; s: number }[] = []): DomIncrementalData {
  return {
    bids: bids.map((r) => ({ ...r, p: P + r.p * 0.25 })),
    asks: asks.map((r) => ({ ...r, p: P + r.p * 0.25 })),
  };
}

function step(n = 1) {
  ms += n * 1000;
  return ms;
}

test("snapshot builds the book and restores per-level tracks", () => {
  const b = new DomBook();
  b.applySnapshot(snap([[0, 10], [1, 5]], [[0, 7]]));
  assert.equal(b.bids.get(P * 4), 10);
  assert.equal(b.asks.get(P * 4), 7);
  const top = b.top(2);
  assert.deepEqual(top.bids.map((r) => r.s), [5, 10]); // best bid first (higher price)
  assert.deepEqual(top.asks.map((r) => r.s), [7]);
});

test("repeated eat-then-refill at one bid level flags an iceberg", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25, minRefillSize: 2 });
  b.applySnapshot(snap([[0, 8]]));
  // the hidden order shows a slice of 8; aggressors eat it, it comes back
  for (let i = 0; i < 4; i++) {
    b.applyIncremental(incr([{ p: 0, s: 0 }]), step()); // eaten to 0
    b.applyIncremental(incr([{ p: 0, s: 8 }]), step()); // slice refilled
  }
  const cands = b.detect(ms);
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.side, "bid");
  assert.equal(c.price, P);
  assert.equal(c.refills, 4);
  assert.equal(c.absorbed, 32);
  assert.equal(c.refillSize, 8);
  assert.equal(c.refillConsistency, 1);
  assert.ok(c.confidence >= 0.6, `confidence ${c.confidence} should be material`);
});

test("delete-then-re-add counts as a refill (the DOM 'd' action)", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25, minRefillSize: 2 });
  b.applySnapshot(snap([[0, 9]]));
  for (let i = 0; i < 3; i++) {
    b.applyIncremental(incr([{ a: "d", p: 0, s: 0 }]), step());
    b.applyIncremental(incr([{ p: 0, s: 9 }]), step());
  }
  const cands = b.detect(ms);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].refills, 3);
  assert.equal(cands[0].absorbed, 27);
});

test("a level that only shrinks (no refill) is not a candidate", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25 });
  b.applySnapshot(snap([[0, 40]]));
  b.applyIncremental(incr([{ p: 0, s: 30 }]), step());
  b.applyIncremental(incr([{ p: 0, s: 20 }]), step());
  b.applyIncremental(incr([{ p: 0, s: 10 }]), step());
  assert.equal(b.detect(ms).length, 0);
});

test("one-shot adds without a prior consumption are not refills", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25 });
  b.applySnapshot(snap([[0, 2]]));
  // size keeps growing with no eat in between — queue joins, not an iceberg
  for (let i = 0; i < 5; i++) b.applyIncremental(incr([{ p: 0, s: 2 + i }]), step());
  assert.equal(b.detect(ms).length, 0);
});

test("1-lot flicker below minRefillSize is ignored", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25, minRefillSize: 2 });
  b.applySnapshot(snap([[0, 10]]));
  for (let i = 0; i < 5; i++) {
    b.applyIncremental(incr([{ p: 0, s: 9 }]), step()); // eaten 1
    b.applyIncremental(incr([{ p: 0, s: 10 }]), step()); // +1 refill (below min)
  }
  assert.equal(b.detect(ms).length, 0);
});

test("inconsistent refill amounts lower confidence but stay detectable", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 15, minRefillSize: 2 });
  b.applySnapshot(snap([[0, 5]]));
  const amounts = [5, 2, 5, 5]; // mostly 5 — mode wins; eaten total = 5+2+5+5
  for (const a of amounts) {
    b.applyIncremental(incr([{ p: 0, s: 0 }]), step());
    b.applyIncremental(incr([{ p: 0, s: a }]), step());
  }
  const [c] = b.detect(ms);
  assert.ok(c, "candidate expected");
  assert.equal(c.refillSize, 5);
  assert.ok(c.refillConsistency < 1 && c.refillConsistency >= 0.75);
});

test("the window decays stale activity — no phantom candidates later", () => {
  const b = new DomBook({ minRefills: 3, minAbsorbed: 25, windowMs: 90_000 });
  b.applySnapshot(snap([[0, 9]]));
  for (let i = 0; i < 3; i++) {
    b.applyIncremental(incr([{ p: 0, s: 0 }]), step());
    b.applyIncremental(incr([{ p: 0, s: 9 }]), step());
  }
  assert.equal(b.detect(ms).length, 1);
  step(95); // > windowMs later, level quiet
  const later = b.detect(ms);
  assert.equal(later.length, 0, "stale refills must decay");
});

test("price keys stay exact through 0.25-tick rounding", () => {
  const b = new DomBook();
  b.applySnapshot(snap([[0, 1]], [[1, 2]]));
  const p = P + 0.25;
  assert.equal(b.asks.get(p * 4), 2);
  const t = b.top(1);
  assert.deepEqual(t.asks[0], { p, s: 2 });
});

/* ---------------- signal-time DOM context (buildDomContext) ---------------- */

function candidate(over: Partial<IcebergCandidate> = {}): IcebergCandidate {
  return {
    side: "bid",
    price: P,
    size: 8,
    absorbed: 32,
    refills: 4,
    refillSize: 8,
    refillConsistency: 1,
    confidence: 0.9,
    lastRefillMs: ms,
    peak: 10,
    ...over,
  };
}

test("context buckets candidates by distance to entry/stop/target", () => {
  const cands = [
    candidate({ price: P }), // on the entry
    candidate({ price: P + 1.25 }), // outside the 1.0 pt window
    candidate({ side: "ask", price: P - 20 }), // near the stop (20 pts below)
  ];
  const ctx = buildDomContext(cands, { entry: P, stop: P - 20, target: P + 20 }, ms);
  assert.equal(ctx.candidates.length, 3);
  assert.equal(ctx.nearEntry.length, 1);
  assert.equal(ctx.nearEntry[0].price, P);
  assert.equal(ctx.nearStop.length, 1);
  assert.equal(ctx.nearStop[0].side, "ask");
  assert.equal(ctx.nearTarget.length, 0);
});

test("context never throws on garbage ticket strings", () => {
  const ctx = buildDomContext([candidate()], { entry: "—", stop: "invalidation", target: undefined }, ms);
  assert.equal(ctx.candidates.length, 1);
  assert.deepEqual(ctx.nearEntry, []);
  assert.deepEqual(ctx.nearStop, []);
  assert.deepEqual(ctx.nearTarget, []);
});

test("context compacts to at most 5 candidates and drops detector-only fields", () => {
  const cands = Array.from({ length: 7 }, (_, i) => candidate({ price: P + i * 0.25 }));
  const ctx = buildDomContext(cands, { entry: P - 100 }, ms);
  assert.equal(ctx.candidates.length, 5);
  const first = ctx.candidates[0] as Record<string, unknown>;
  assert.ok(!("lastRefillMs" in first), "compact rows must not leak detector internals");
  assert.ok(!("peak" in first));
  assert.equal(typeof ctx.ts, "number");
});

/* ---------------- ES symbol derivation + compaction helpers ---------------- */

test("esSymbolFor derives the ES front month from the NQ symbol", () => {
  assert.equal(esSymbolFor("NQZ26"), "ESZ26");
  assert.equal(esSymbolFor("NQH24"), "ESH24");
  assert.equal(esSymbolFor("NQM25"), "ESM25");
  assert.equal(esSymbolFor("nqu26"), "ESU26");
  assert.equal(esSymbolFor(""), null);
  assert.equal(esSymbolFor("MNQZ26"), null); // micros are not the cycle anchor
  assert.equal(esSymbolFor("NQ1!"), null);
});

test("compactCandidates caps at 5 and strips detector internals", () => {
  const rows = Array.from({ length: 8 }, (_, i) => candidate({ price: P + i * 0.25 }));
  const out = compactCandidates(rows);
  assert.equal(out.length, 5);
  const first = out[0] as Record<string, unknown>;
  assert.ok(!("lastRefillMs" in first));
  assert.ok(!("peak" in first));
  assert.equal(first.side, "bid");
});
