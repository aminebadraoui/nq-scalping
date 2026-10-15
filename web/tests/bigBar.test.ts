/* Unit tests for the big-bar continuation detector (lib/bigBar.ts) —
 * family D, the reverse-engineered macro-day capture pattern. */
import { test } from "node:test";
import assert from "node:assert";
import { detectBigBar, BIGBAR_MIN_RANGE, BIGBAR_PREFIX_SKIP } from "../lib/bigBar";
import type { BigBarMinute } from "../lib/bigBar";

const mk = (n: number, big?: { at: number; deltaSign: 1 | -1; range?: number }): BigBarMinute[] => {
  const out: BigBarMinute[] = [];
  for (let i = 0; i < n; i++) {
    const t = `${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
    const quiet = { t, d: "2026-10-15", high: 1000 + 1, low: 999, buy: 5, sell: 5, c: 999.5 };
    if (big && i === big.at) {
      const range = big.range ?? BIGBAR_MIN_RANGE + 5;
      const sell = big.deltaSign === -1 ? 900 : 100;
      const buy = big.deltaSign === -1 ? 100 : 900;
      out.push({ t, d: "2026-10-15", high: 1000 + range, low: 1000, buy, sell, c: 1000 + (big.deltaSign === -1 ? 2 : range - 2) });
    } else {
      out.push({ ...quiet, t });
    }
  }
  return out;
};

test("fires on the first ≥100-pt bar, in its delta direction, as a flush-kind signal", () => {
  const s = detectBigBar(mk(45, { at: 40, deltaSign: -1 }));
  assert.ok(s);
  assert.strictEqual(s.dir, "short");
  assert.strictEqual(s.kind, "flush"); // rides the flush-limit path
  assert.strictEqual(s.entryIdx, 40);
  assert.ok(s.stop > s.entry); // short: stop above
  assert.ok(s.target < s.entry); // short: target below
  assert.ok(Math.abs(s.risk - Math.abs(s.entry - s.stop)) < 1e-9);
  assert.ok(Math.abs(s.target - (s.entry - s.risk)) < 1e-9); // 1R
});

test("long side fires on buy dominance", () => {
  const s = detectBigBar(mk(45, { at: 40, deltaSign: 1 }));
  assert.ok(s);
  assert.strictEqual(s.dir, "long");
  assert.ok(s.stop < s.entry && s.target > s.entry);
});

test("no fire when no bar reaches the 100-pt threshold", () => {
  assert.strictEqual(detectBigBar(mk(60, { at: 40, deltaSign: -1, range: 99 })), null);
});

test("the session prefix is ignored (first 30 bars can never trigger)", () => {
  assert.strictEqual(detectBigBar(mk(45, { at: BIGBAR_PREFIX_SKIP - 1, deltaSign: -1 })), null);
});

test("delta == 0 (balanced bar) never fires", () => {
  const mins = mk(45, { at: 40, deltaSign: 1 });
  mins[40].buy = 50;
  mins[40].sell = 50;
  assert.strictEqual(detectBigBar(mins), null);
});

test("only the FIRST qualifying bar is returned", () => {
  const mins = mk(50, { at: 35, deltaSign: -1 });
  mins[45] = { ...mins[45], high: 2000, low: 1000, buy: 10, sell: 990 };
  const s = detectBigBar(mins);
  assert.ok(s);
  assert.strictEqual(s.entryIdx, 35);
});

test("risk floors at 3.5 pts on a quiet-tape session (the house widen floor)", () => {
  const s = detectBigBar(mk(45, { at: 40, deltaSign: -1 }));
  assert.ok(s);
  assert.ok(s.risk >= 3.5);
});
