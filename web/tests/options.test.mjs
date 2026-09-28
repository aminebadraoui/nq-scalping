/* Options/gamma box regression tests (offline — fixture from the free CBOE
 * delayed-quotes endpoint, captured 2026-09-26). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseSymbol,
  parseChain,
  inferSpot,
  gammaProfile,
  computeGamma,
  computeGammaByExpiry,
  daysToExpiry,
  bucketOf,
  readOptionsFromSnapshot,
  wallsFromRead,
  dealerBand,
} from "../lib/options.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/qqq_sample.json", import.meta.url), "utf8"),
);

test("option symbol parses to expiry, side and strike", () => {
  assert.deepEqual(parseSymbol("QQQ260928C00450000"), { expiry: "2026-09-28", side: "call", strike: 450 });
  assert.deepEqual(parseSymbol("QQQ260928P00727000"), { expiry: "2026-09-28", side: "put", strike: 727 });
});

test("inferSpot lands on the at-the-money call of the nearest expiry", () => {
  const rows = parseChain(fixture.options);
  const spot = inferSpot(rows);
  assert.ok(Number.isFinite(spot), "spot is finite");
  assert.ok(spot >= 740 && spot <= 750, `spot ${spot} is near the ~745 ATM`);
});

test("gamma profile aggregates per strike: net = call − put, sorted ascending", () => {
  const rows = parseChain(fixture.options);
  const prof = gammaProfile(rows);
  assert.ok(prof.length > 0);
  for (let i = 0; i < prof.length; i++) {
    const s = prof[i];
    assert.equal(s.net, s.callGex - s.putGex);
    if (i > 0) assert.ok(s.strike > prof[i - 1].strike, "strikes ascending");
    assert.ok(!Number.isNaN(s.net) && !Number.isNaN(s.callGex) && !Number.isNaN(s.putGex));
  }
});

test("computeGamma finds a flip, call wall and put wall and a regime", () => {
  const rows = parseChain(fixture.options);
  const g = computeGamma(rows, 745);
  assert.equal(g.regime !== "unknown", true, "real chain produces a regime");
  assert.ok(g.flip !== null && Number.isFinite(g.flip), "flip is finite");
  assert.ok(g.callWall !== null && Number.isFinite(g.callWall));
  assert.ok(g.putWall !== null && Number.isFinite(g.putWall));
  assert.ok(g.callWall > g.putWall, "call wall sits above the put wall");
  assert.ok(Math.abs(g.flip - 745) / 745 < 0.1, `flip ${g.flip} sits near spot (within 10%)`);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(g)));
});

test("NQ mapping scales levels by the live NQ/QQQ ratio", () => {
  const rows = parseChain(fixture.options);
  const g = computeGamma(rows, 745);
  const nq = 745 * 41; // NQ ≈ 41 × QQQ
  const r = readOptionsFromSnapshot(g, nq);
  assert.equal(r.dataOk, true);
  assert.ok(Math.abs(r.flipNq - g.flip * 41) < 1, "flip maps by ratio");
  assert.ok(Math.abs(r.callWallNq - g.callWall * 41) < 1);
  assert.ok(Math.abs(r.putWallNq - g.putWall * 41) < 1);
  assert.equal(r.nqSpot, nq);
  assert.ok(r.note.length > 0);
});

test("empty / missing input degrades to 'unknown' without NaN", () => {
  const empty = computeGamma([], NaN);
  assert.equal(empty.regime, "unknown");
  assert.equal(empty.flip, null);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(empty)));

  const none = readOptionsFromSnapshot(empty, 0);
  assert.equal(none.dataOk, false);
  assert.equal(none.regime, "unknown");
  assert.equal(none.flipNq, null);
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(none)));
});

test("wallsFromRead keeps call/put/flip and drops nulls", () => {
  const walls = wallsFromRead({ callWallNq: 31160, putWallNq: null, flipNq: 30300 });
  assert.deepEqual(walls.map((w) => w.kind), ["call", "flip"]);
  assert.deepEqual(walls.map((w) => w.p), [31160, 30300]);
});

test("dealerBand maps the put→call range and clamps the price position", () => {
  const band = dealerBand({ callWallNq: 31160, putWallNq: 29930, flipNq: 30300, nqSpot: 30545 });
  assert.equal(band.put, 29930);
  assert.equal(band.call, 31160);
  assert.equal(band.span, 1230);
  assert.ok(Math.abs(band.pct - (30545 - 29930) / 1230) < 1e-9);
});

test("dealerBand returns null when walls are missing or inverted", () => {
  assert.equal(dealerBand({ callWallNq: null, putWallNq: null, flipNq: null, nqSpot: 0 }), null);
  assert.equal(dealerBand({ callWallNq: 100, putWallNq: 200, flipNq: 150, nqSpot: 150 }), null);
});

test("expiry bucketing: near ≤7d, monthly 8–45d, far >45d", () => {
  assert.equal(bucketOf(daysToExpiry("2026-09-28", "2026-09-27")), "near");
  assert.equal(bucketOf(daysToExpiry("2026-10-04", "2026-09-27")), "near"); // 7 days
  assert.equal(bucketOf(daysToExpiry("2026-10-05", "2026-09-27")), "monthly"); // 8 days
  assert.equal(bucketOf(daysToExpiry("2026-11-11", "2026-09-27")), "monthly"); // 45 days
  assert.equal(bucketOf(daysToExpiry("2026-11-12", "2026-09-27")), "far"); // 46 days
  assert.equal(bucketOf(-1), null);
});

test("computeGammaByExpiry splits walls by expiration bucket", () => {
  // fixture expirations are 2026-09-28 and 2026-09-29 — both "near" vs 2026-09-27
  const rows = parseChain(fixture.options);
  const by = computeGammaByExpiry(rows, 745, "2026-09-27");
  assert.ok(by.near, "near bucket populated");
  assert.ok(by.near.callWall !== null && by.near.putWall !== null);
  assert.equal(by.monthly, null);
  assert.equal(by.far, null);
});

test("wallsFromRead prefers near-term walls over the total", () => {
  const walls = wallsFromRead({
    callWallNq: 31160, putWallNq: 29930, flipNq: 30300,
    near: { callWall: 30800, putWall: 30300, flip: 30500 },
    monthly: null, far: null,
  });
  assert.deepEqual(walls, [
    { kind: "call", p: 30800 },
    { kind: "put", p: 30300 },
    { kind: "flip", p: 30500 },
  ]);
});
