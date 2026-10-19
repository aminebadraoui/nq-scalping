/* Unit tests for the cost-adjusted ticket veto (lib/ticketVeto.ts):
 * the pure gate decision against the measured expectancy table. */
import { test } from "node:test";
import assert from "node:assert";
import { ticketVetoDecision, ticketVetoBar, TICKET_EXPECTANCY, TICKET_EXPECTANCY_SIDES } from "../lib/ticketVeto";

test("gate is OFF when the bar is 0 or unset", () => {
  const saved = process.env.TICKET_MIN_EXP_PTS;
  try {
    delete process.env.TICKET_MIN_EXP_PTS;
    assert.equal(ticketVetoBar(), 0);
    assert.equal(ticketVetoDecision({ family: "huge_bar_expansion", hourBucket: "close", dir: "short" }, 0).veto, false);
    assert.equal(ticketVetoDecision({ family: "huge_bar_expansion", hourBucket: "close", dir: "short" }, ticketVetoBar()).veto, false);
    process.env.TICKET_MIN_EXP_PTS = "garbage";
    assert.equal(ticketVetoBar(), 0);
    process.env.TICKET_MIN_EXP_PTS = "-1";
    assert.equal(ticketVetoBar(), 0);
  } finally {
    if (saved === undefined) delete process.env.TICKET_MIN_EXP_PTS;
    else process.env.TICKET_MIN_EXP_PTS = saved;
  }
});

test("ticketVetoBar parses a positive bar", () => {
  const saved = process.env.TICKET_MIN_EXP_PTS;
  try {
    process.env.TICKET_MIN_EXP_PTS = "1.0";
    assert.equal(ticketVetoBar(), 1.0);
  } finally {
    if (saved === undefined) delete process.env.TICKET_MIN_EXP_PTS;
    else process.env.TICKET_MIN_EXP_PTS = saved;
  }
});

test("vetoes a cell whose measured expectancy is below the bar", () => {
  // expansion close-window shorts measured +0.75 pts/trade (expansionStudy)
  const d = ticketVetoDecision({ family: "huge_bar_expansion", hourBucket: "close", dir: "short" }, 1.0);
  assert.equal(d.veto, true);
  assert.match(d.reason, /\+0\.75/);
});

test("allows the same cell when the bar sits below its expectancy", () => {
  const d = ticketVetoDecision({ family: "huge_bar_expansion", hourBucket: "close", dir: "short" }, 0.5);
  assert.equal(d.veto, false);
});

test("side-specific cell overrides the bucket cell (close longs keep their edge)", () => {
  const d = ticketVetoDecision({ family: "huge_bar_expansion", hourBucket: "close", dir: "long" }, 1.0);
  assert.equal(d.veto, false); // +2.13 ≥ 1.0 — the close-window veto must not kill longs
});

test("unknown cells fail OPEN (no veto) so a table gap can never block tickets", () => {
  assert.equal(ticketVetoDecision({ family: "failed_flush_breakout", hourBucket: "rth" }, 1.0).veto, false);
  assert.equal(ticketVetoDecision({ family: "no_such_family", hourBucket: "rth" }, 5.0).veto, false);
});

test("every table cell is a finite positive number (table sanity)", () => {
  for (const [fam, buckets] of Object.entries(TICKET_EXPECTANCY)) {
    for (const [bucket, exp] of Object.entries(buckets)) {
      assert.ok(Number.isFinite(exp) && exp > 0, `${fam}/${bucket} = ${exp}`);
    }
  }
  for (const [key, exp] of Object.entries(TICKET_EXPECTANCY_SIDES)) {
    assert.ok(Number.isFinite(exp) && exp > 0, `${key} = ${exp}`);
    assert.ok(key.split("/").length === 3, `side key shape: ${key}`);
  }
});
