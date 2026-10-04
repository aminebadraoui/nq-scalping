/* CVD divergence (lib/divergence.ts) — the shared D2/D4 definition:
 * strict ±2-bar pivots, CVD comparison across consecutive pivots. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDivergences, cumulativeDelta, divergenceFuel } from "../lib/divergence.ts";

const mk = (high, low, delta) => ({ high, low, buy: Math.max(0, delta), sell: Math.max(0, -delta) });

test("cumulativeDelta: running buy−sell", () => {
  assert.deepEqual(
    cumulativeDelta([{ buy: 10, sell: 5 }, { buy: 2, sell: 9 }, { buy: 4, sell: 4 }]),
    [5, -2, -2],
  );
});

test("D2: lower pivot low with higher CVD → bullish divergence at the second pivot", () => {
  const bars = Array.from({ length: 20 }, (_, i) => mk(100 + i * 0.1, 99 + i * 0.1, 5)); // gentle uptrend
  bars[6] = mk(101, 97.5, 5); // pivot low A (lower than ±2 neighbours)
  bars[12] = mk(102, 96.0, 30); // pivot low B — LOWER low but big buying
  const divs = computeDivergences(bars);
  assert.ok(divs.some((d) => d.index === 12 && d.kind === "D2" && d.bias === "bull" && d.price === 96.0));
});

test("D4: higher pivot high with lower CVD → bearish divergence at the second pivot", () => {
  const bars = Array.from({ length: 20 }, (_, i) => mk(100 + i * 0.1, 99 + i * 0.1, -5));
  bars[6] = mk(103, 101, -5); // pivot high A
  bars[12] = mk(104.5, 102, -30); // pivot high B — HIGHER high, heavier selling
  const divs = computeDivergences(bars);
  assert.ok(divs.some((d) => d.index === 12 && d.kind === "D4" && d.bias === "bear" && d.price === 104.5));
});

test("no divergence when CVD confirms the extension", () => {
  const bars = Array.from({ length: 20 }, (_, i) => mk(100 + i * 0.1, 99 + i * 0.1, 5));
  bars[6] = mk(101, 97.5, 5);
  bars[12] = mk(102, 96.0, -40); // lower low AND lower CVD → no D2
  const divs = computeDivergences(bars);
  assert.equal(divs.some((d) => d.index === 12 && d.kind === "D2"), false);
});

test("short arrays and flat tapes yield nothing", () => {
  assert.deepEqual(computeDivergences([]), []);
  assert.deepEqual(computeDivergences([mk(1, 1, 0), mk(1, 1, 0)]), []);
  const flat = Array.from({ length: 30 }, () => mk(100, 99, 1));
  assert.deepEqual(computeDivergences(flat), []);
});

test("each divergence carries its CVD and the prior pivot it diverged from", () => {
  const bars = Array.from({ length: 20 }, (_, i) => mk(100 + i * 0.1, 99 + i * 0.1, 5));
  bars[6] = mk(101, 97.5, 5); // pivot low A
  bars[12] = mk(102, 96.0, 30); // pivot low B — LOWER low but big buying
  const divs = computeDivergences(bars);
  const d = divs.find((x) => x.index === 12);
  assert.ok(d, "D2 at bar 12 exists");
  assert.equal(d.kind, "D2");
  assert.equal(d.prior.index, 6, "prior pivot is bar 6");
  assert.equal(d.prior.price, 97.5);
  assert.ok(d.cvd > d.prior.cvd, "CVD higher than at the prior pivot (the divergence itself)");
  assert.equal(d.cvd, cumulativeDelta(bars)[12]);
});

test("divergenceFuel: matching kind within the window fuels the side", () => {
  const divs = [
    { kind: "D2", t: "09:58" },
    { kind: "D4", t: "10:00" },
  ];
  assert.equal(divergenceFuel(divs, "10:05", "long", 10)?.t, "09:58", "D2 within 10 bars fuels a long");
  assert.equal(divergenceFuel(divs, "10:05", "short", 10)?.t, "10:00", "D4 fuels a short");
  assert.equal(divergenceFuel(divs, "10:05", "long", 5), null, "too old (7 bars back) does not fuel");
  assert.equal(divergenceFuel(divs, "09:57", "long", 10), null, "a divergence AFTER the entry never fuels");
  assert.equal(divergenceFuel([], "10:05", "long", 10), null);
  // boundary: exactly windowBars back still counts
  assert.equal(divergenceFuel(divs, "10:10", "short", 10)?.t, "10:00");
});
