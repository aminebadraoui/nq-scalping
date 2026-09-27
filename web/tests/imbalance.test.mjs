/* Imbalance engine: fixture-level rules + a full-session recomputation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { imbalanceFor, summarizeImb, IMB_RATIO, IMB_MIN } from "../lib/imbalance.ts";
import { loadDay, DATE } from "./helpers.mjs";

const rows = (spec) => spec.map(([price, buy, sell]) => ({ price, buy, sell }));
const flags = (r) => imbalanceFor(r).map((l) => `${l.dBuy ? "B" : "-"}${l.dSell ? "S" : "-"}${l.hBuy ? "b" : "-"}${l.hSell ? "s" : "-"}`);

test("thresholds are the documented 3:1 and 10 contracts", () => {
  assert.equal(IMB_RATIO, 3);
  assert.equal(IMB_MIN, 10);
});

test("exactly 3:1 counts, just under does not", () => {
  // rows sorted high -> low: the row below supplies the diagonal counterpart
  const at = rows([[100, 30, 1], [99.75, 1, 10]]);
  assert.ok(imbalanceFor(at)[0].dBuy, "30 vs 10 = 3:1 is an imbalance");
  const under = rows([[100, 29, 1], [99.75, 1, 10]]);
  assert.ok(!imbalanceFor(under)[0].dBuy, "29 vs 10 = 2.9:1 is not");
});

test("the dominant side must reach 10 contracts", () => {
  assert.ok(imbalanceFor(rows([[100, 10, 1], [99.75, 1, 2]]))[0].dBuy, "10 contracts qualifies");
  assert.ok(!imbalanceFor(rows([[100, 9, 1], [99.75, 1, 2]]))[0].dBuy, "9 contracts does not");
});

test("horizontal imbalance needs both sides traded and total >= 10", () => {
  const both = imbalanceFor(rows([[100, 30, 10]]))[0];
  assert.ok(both.hBuy, "30 vs 10 with both sides traded");
  const zeroSide = imbalanceFor(rows([[100, 30, 0]]))[0];
  assert.ok(!zeroSide.hBuy, "a one-sided print is an unfinished auction, not a horizontal imbalance");
  // per the documented rule the size gate for the HORIZONTAL test is the row
  // TOTAL (>= IMB_MIN), not the dominant side
  const gate = imbalanceFor(rows([[100, 9, 3]]))[0];
  assert.ok(gate.hBuy, "9 vs 3 with total 12 passes the total gate");
  const under = imbalanceFor(rows([[100, 6, 2]]))[0];
  assert.ok(!under.hBuy, "6 vs 2 with total 8 is below the total gate");
});

test("diagonal flags point the right way", () => {
  // buy diagonal: a row's buy vs the row BELOW's sell
  // sell diagonal: a row's sell vs the row ABOVE's buy
  // (the outermost rows have no neighbour on one side, so that flag is false)
  const buyDiag = imbalanceFor(rows([[100.25, 2, 1], [100, 40, 1], [99.75, 1, 2]]));
  assert.ok(buyDiag[1].dBuy, "middle row buy 40 vs below sell 2");
  assert.ok(!buyDiag[1].dSell, "40 vs above buy 2 is a buy diagonal, not sell");

  const sellDiag = imbalanceFor(rows([[100.25, 2, 1], [100, 1, 40], [99.75, 40, 1]]));
  assert.ok(sellDiag[1].dSell, "middle row sell 40 vs above buy 2");
  assert.ok(!sellDiag[1].dBuy, "buy side is only 1 contract");

  // with only two rows each row is missing one neighbour, and the sell side of
  // the bottom row is only 1 contract — so nothing qualifies here
  const two = imbalanceFor(rows([[100, 1, 40], [99.75, 40, 1]]));
  assert.deepEqual(two.map((l) => [l.dBuy, l.dSell]), [[false, false], [false, false]]);
});

test("stacked runs: longest same-side run >= 3 wins, breaks reset it", () => {
  const run3 = summarizeImb(imbalanceFor(rows([
    [100.5, 20, 1], [100.25, 20, 1], [100, 20, 1], [99.75, 5, 5],
  ])));
  assert.deepEqual(run3.stacked, { side: "buy", from: 100.5, to: 100, len: 3 });

  const run5 = summarizeImb(imbalanceFor(rows([
    [100.5, 20, 1], [100.25, 20, 1], [100, 20, 1], [99.75, 20, 1], [99.5, 20, 1], [99.25, 5, 5],
  ])));
  assert.equal(run5.stacked.len, 5, "longest run wins");

  const broke3 = summarizeImb(imbalanceFor(rows([
    [100.5, 20, 1], [100.25, 5, 5], [100, 20, 1], [99.75, 20, 1],
  ])));
  assert.equal(broke3.stacked, null, "a break in the middle yields no stack");
});

test("every reported stack on the real session is a maximal run", () => {
  const candles = loadDay(DATE, "RTH");
  let checked = 0;
  for (const c of candles) {
    const levels = Object.entries(c.levels)
      .map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] }))
      .sort((a, b) => b.price - a.price);
    const lv = imbalanceFor(levels);
    const s = summarizeImb(lv).stacked;
    if (!s) continue;
    checked++;
    const side = (l) => (l.dBuy || l.hBuy ? "buy" : l.dSell || l.hSell ? "sell" : null);
    const i0 = lv.findIndex((l) => l.price === s.from);
    const i1 = lv.findIndex((l) => l.price === s.to);
    assert.ok(s.len >= 3, "stack length >= 3");
    assert.equal(i1 - i0 + 1, s.len, "from/to span the reported length");
    for (let i = i0; i <= i1; i++) assert.equal(side(lv[i]), s.side, `row ${i} is on the stack side`);
    // a run touching the first/last row is trivially maximal on that side
    if (i0 > 0) assert.notEqual(side(lv[i0 - 1]), s.side, "run is maximal at the top");
    if (i1 < lv.length - 1) assert.notEqual(side(lv[i1 + 1]), s.side, "run is maximal at the bottom");
  }
  assert.equal(checked, 177, "golden: minutes containing a stack");
});

test("engine flags match an independent recomputation over the whole session", () => {
  const candles = loadDay(DATE, "RTH");
  let rows = 0;
  let mismatches = 0;
  for (const c of candles) {
    const levels = Object.entries(c.levels)
      .map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] }))
      .sort((a, b) => b.price - a.price);
    const got = imbalanceFor(levels);
    const exp = levels.map((r, i) => {
      const below = levels[i + 1];
      const above = levels[i - 1];
      const dBuy = !!below && r.buy >= IMB_MIN && r.buy / Math.max(1, below.sell) >= IMB_RATIO;
      const dSell = !!above && r.sell >= IMB_MIN && r.sell / Math.max(1, above.buy) >= IMB_RATIO;
      const tot = r.buy + r.sell;
      const hBuy = tot >= IMB_MIN && r.sell > 0 && r.buy >= IMB_RATIO * r.sell;
      const hSell = tot >= IMB_MIN && r.buy > 0 && r.sell >= IMB_RATIO * r.buy;
      return `${dBuy}|${dSell}|${hBuy}|${hSell}`;
    });
    for (let i = 0; i < levels.length; i++) {
      rows++;
      const g = `${got[i].dBuy}|${got[i].dSell}|${got[i].hBuy}|${got[i].hSell}`;
      if (g !== exp[i]) mismatches++;
    }
  }
  assert.ok(rows > 20000, `swept ${rows} rows`);
  assert.equal(mismatches, 0, "no flag mismatches across the session");
});

test("summary counts equal the level flags", () => {
  const candles = loadDay(DATE, "RTH");
  const c = candles[0];
  const levels = Object.entries(c.levels)
    .map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] }))
    .sort((a, b) => b.price - a.price);
  const lv = imbalanceFor(levels);
  const s = summarizeImb(lv);
  assert.equal(s.buy, lv.filter((l) => l.dBuy || l.hBuy).length);
  assert.equal(s.sell, lv.filter((l) => l.dSell || l.hSell).length);
  assert.equal(s.dBuy, lv.filter((l) => l.dBuy).length);
  assert.equal(s.dSell, lv.filter((l) => l.dSell).length);
});

test("degenerate inputs never throw or leak NaN", () => {
  for (const input of [[], [{ price: 100, buy: 0, sell: 0 }], [{ price: 100, buy: 1, sell: 0 }]]) {
    const lv = imbalanceFor(input);
    const s = summarizeImb(lv);
    assert.ok(Number.isFinite(s.buy) && Number.isFinite(s.sell));
    assert.ok(s.stacked === null || Number.isFinite(s.stacked.from));
    assert.ok(!JSON.stringify(s).includes("NaN"));
  }
});
