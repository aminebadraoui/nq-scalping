/* Unit tests for the prop-account simulator (lib/propAccount.ts) — the rules
 * layer every backtest now runs through. Grounded in the MyFundedFutures
 * Rapid EOD 50k plan:
 *   https://help.myfundedfutures.com/en/articles/16158363-rapid-eod-50k-a-comprehensive-look
 *   · $2,000 MLL, EOD trailing, locks at $100 · profit target $3,000
 *   · 4 min trading days · 30% consistency (eval) · $2,100 buffer, $500 steps */
import { test } from "node:test";
import assert from "node:assert";
import { simulateAccount, dollarize, accountLine, type AccountSimResult } from "../lib/propAccount";
import { RAPID_EOD_50K, momentumSize } from "../lib/propRules";

test("EOD trailing floor only moves at closes and never down", () => {
  // day 1 loses $1,500 (intraday it would have blown an intraday-trailing
  // account; EOD only cares about the close), day 2 recovers +$1,500
  const s = simulateAccount(
    [
      { date: "2026-09-01", pnl: -1500 },
      { date: "2026-09-02", pnl: 1500 },
    ],
    "funded",
  );
  assert.equal(s.breachDay, null);
  // floor started at -2000 and never dropped despite the $1,500 down-day
  assert.equal(s.days[0].floor, -2000);
  assert.equal(s.days[1].floor, -2000);
  assert.equal(s.finalEquity, 0);
});

test("the floor trails up at new closing highs and locks at $100", () => {
  const s = simulateAccount(
    [
      { date: "2026-09-01", pnl: 500 }, // closes 500  → next floor -1500
      { date: "2026-09-02", pnl: 500 }, // closes 1000 → next floor -1000
      { date: "2026-09-03", pnl: 1100 }, // closes 2100 → floor reaches 100 → locks
      { date: "2026-09-04", pnl: -900 }, // closes 1200 — floor must stay 100
    ],
    "funded",
  );
  // days[i].floor is the floor IN FORCE during day i (breach is judged
  // against it, then it updates at that close)
  assert.equal(s.days[0].floor, -2000);
  assert.equal(s.days[1].floor, -1500);
  assert.equal(s.days[2].floor, -1000);
  assert.equal(s.days[2].locked, false);
  assert.equal(s.days[3].floor, 100, "floor reached $100 at equity $2,100");
  assert.equal(s.days[3].locked, true, "locked at $100");
  assert.equal(s.floor, 100, "final floor locked");
  assert.equal(s.locked, true);
  assert.equal(s.breachDay, null, "equity $1,200 stays above the locked $100");
});

test("a close below the floor is a breach", () => {
  const s = simulateAccount([{ date: "2026-09-01", pnl: -2100 }], "funded");
  assert.equal(s.breachDay, "2026-09-01");
  assert.equal(s.breachEquity, -2100);
  assert.equal(s.payouts, 0);
});

test("breach at exactly the $2,000 MLL does not fire (close must be BELOW)", () => {
  const s = simulateAccount([{ date: "2026-09-01", pnl: -2000 }], "funded");
  assert.equal(s.breachDay, null);
});

test("eval pass requires target + 4 trading days + 30% consistency", () => {
  // $3,000 over 4 even days: best day $750 = 25% of $3,000 → consistent
  const s = simulateAccount(
    [
      { date: "2026-09-01", pnl: 750 },
      { date: "2026-09-02", pnl: 750 },
      { date: "2026-09-03", pnl: 750 },
      { date: "2026-09-04", pnl: 750 },
    ],
    "eval",
  );
  assert.equal(s.passDay, "2026-09-04");
  assert.equal(s.consistencyOk, true);
  assert.equal(s.minDaysOk, true);
  assert.equal(s.passEquity, 3000);
});

test("eval fails the 30% consistency rule when one day dominates", () => {
  const s = simulateAccount(
    [
      { date: "2026-09-01", pnl: 2100 }, // 70% of the total in one day
      { date: "2026-09-02", pnl: 300 },
      { date: "2026-09-03", pnl: 300 },
      { date: "2026-09-04", pnl: 300 },
    ],
    "eval",
  );
  assert.equal(s.finalEquity, 3000);
  assert.equal(s.consistencyOk, false, "best day 70% > 30%");
});

test("eval cannot pass before the 4 trading days minimum", () => {
  const s = simulateAccount(
    [
      { date: "2026-09-01", pnl: 1500 },
      { date: "2026-09-02", pnl: 1500 },
    ],
    "eval",
  );
  assert.equal(s.finalEquity, 3000);
  assert.equal(s.passDay, null, "only 2 trading days");
  assert.equal(s.minDaysOk, false);
});

test("funded payouts: $2,100 buffer, then one per +$500", () => {
  const s = simulateAccount([{ date: "2026-09-01", pnl: 2600 }], "funded");
  assert.equal(s.payouts, 2); // buffer cleared at 2100, +500 → 2nd payout
  const s0 = simulateAccount([{ date: "2026-09-01", pnl: 2000 }], "funded");
  assert.equal(s0.payouts, 0, "below the $2,100 buffer");
});

test("dollarize sizes every trade under the plan and converts at $2/pt", () => {
  const tr = dollarize([
    { date: "2026-09-01", pnlPts: 3.5, riskPts: 3.5 }, // +1R win
    { date: "2026-09-01", pnlPts: -4.0, riskPts: 3.5 }, // stop + 0.5 cost
    { date: "2026-09-01", pnlPts: -0.75, riskPts: 0.25 }, // 30-micro cap binds
  ]);
  assert.equal(tr[0].contracts, 24); // floor(170 / 7)
  assert.equal(tr[0].pnl, 168); // 3.5 × $2 × 24
  assert.equal(tr[1].pnl, -192); // -4.0 × $2 × 24
  assert.equal(tr[2].contracts, 30); // capped at 30 micros
  assert.equal(tr[2].pnl, -45); // -0.75 × $2 × 30
  // every size stays inside the plan's contract cap
  for (const t of tr) assert.ok(t.contracts <= RAPID_EOD_50K.maxMicro);
});

test("accountLine reports breaches and passes readably", () => {
  const b = simulateAccount([{ date: "2026-09-01", pnl: -2500 }], "funded");
  assert.match(accountLine(b), /breach 2026-09-01/);
  const p = simulateAccount(
    [
      { date: "2026-09-01", pnl: 750 },
      { date: "2026-09-02", pnl: 750 },
      { date: "2026-09-03", pnl: 750 },
      { date: "2026-09-04", pnl: 750 },
    ],
    "eval",
  );
  assert.match(accountLine(p), /PASS 2026-09-04/);
});

test("momentumSize is the single sizing source the simulator uses", () => {
  const size = momentumSize(3.5);
  const [d] = dollarize([{ date: "2026-09-01", pnlPts: 1, riskPts: 3.5 }]);
  assert.equal(d.contracts, size.contracts);
  assert.equal(d.pnl, 1 * 2 * size.contracts);
});

/* helper used by the harness tests to build a long eval-winning series */
export function evalPassingDays(): { date: string; pnl: number }[] {
  return [750, 750, 750, 750].map((pnl, i) => ({ date: `2026-09-0${i + 1}`, pnl }));
}
export type { AccountSimResult };
