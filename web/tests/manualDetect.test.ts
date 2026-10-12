/* Unit tests for lib/manualDetect.ts — the manual-action detector's
 * pure logic: bot-vs-manual fill classification and manual round-trip
 * pairing/P&L. The poll body itself is exercised on the VPS. */

import { test } from "node:test";
import assert from "node:assert";
import {
  classifyManualFills,
  isBotFill,
  pairManualGroup,
  nyDay,
  __resetManualDetectForTest,
} from "../lib/manualDetect";
import type { TrackedTrade } from "../lib/manualDetect";

process.env.DATABASE_URL = "";
process.env.DAYBOOK_OFF = "1";

const f = (ts: number, action: string, qty: number, price: number, orderId: string, instrument = "MNQZ6") => ({
  ts,
  action,
  qty,
  price,
  orderId,
  instrument,
  commission: 0,
  fees: 0,
});

test("isBotFill claims entry fills by orderId and exit fills by exact match", () => {
  const tracked: TrackedTrade[] = [
    {
      orderId: "bot-entry-1",
      side: "long",
      contracts: 5,
      fillEntryAt: 1000,
      exitFills: [{ ts: 5000, action: "Sell", qty: 5, price: 31102.5 }],
    },
  ];
  const consumed = new Map<number, number>();
  assert.equal(isBotFill(f(1000, "Buy", 5, 31100, "bot-entry-1"), tracked, consumed), true);
  assert.equal(isBotFill(f(5000, "Sell", 5, 31102.5, "bot-stop-leg"), tracked, consumed), true);
  // a second identical fill can't be claimed (qty already consumed)
  assert.equal(isBotFill(f(5000, "Sell", 5, 31102.5, "bot-stop-leg"), tracked, consumed), false);
  // anything else is not the bot's
  assert.equal(isBotFill(f(6000, "Sell", 2, 31105, "manual-1"), tracked, consumed), false);
});

test("classifyManualFills splits MNQ fills into bot vs manual and skips other instruments", () => {
  const tracked: TrackedTrade[] = [
    { orderId: "bot-1", side: "short", contracts: 3, fillEntryAt: 1000, exitFills: [{ ts: 2000, action: "Buy", qty: 3, price: 31099 }] },
  ];
  const fills = [
    f(1000, "Sell", 3, 31100, "bot-1"),          // bot entry
    f(2000, "Buy", 3, 31099, "bot-1-child"),     // bot exit (exact match)
    f(3000, "Buy", 2, 31110, "manual-x"),        // manual entry
    f(4000, "Sell", 2, 31112, "manual-x"),       // manual exit
    f(4500, "Buy", 1, 4000, "es-1", "MESZ6"),    // other instrument — ignored
  ];
  const { bot, manual } = classifyManualFills(fills, tracked);
  assert.equal(bot.length, 2);
  assert.equal(manual.length, 2);
  assert.deepEqual(manual.map((m) => m.orderId), ["manual-x", "manual-x"]);
});

test("pairManualGroup: open one-sided group stays open with no P&L", () => {
  const r = pairManualGroup([
    { ts: 3000, action: "Buy", qty: 2, price: 31110, commission: 0, fees: 0 },
  ]);
  assert.equal(r.side, "long");
  assert.equal(r.closed, false);
  assert.equal(r.pnlUsd, null);
  assert.equal(r.entryPrice, 31110);
});

test("pairManualGroup: closed round trip computes net $ with the reconcile fallback", () => {
  const fills = [
    { ts: 3000, action: "Buy", qty: 2, price: 31110, commission: 0, fees: 0 },
    { ts: 4000, action: "Sell", qty: 2, price: 31112, commission: 0, fees: 0 },
  ];
  const r = pairManualGroup(fills);
  assert.equal(r.closed, true);
  assert.equal(r.entryPrice, 31110);
  assert.equal(r.exitPrice, 31112);
  // +2 pts × 2 contracts × $2 = $8 gross − (4 fills × $0.95) = $4.20
  assert.equal(r.pnlUsd, 4.2);
});

test("pairManualGroup: short loser with real fees", () => {
  const fills = [
    { ts: 3000, action: "Sell", qty: 1, price: 31200, commission: 0.62, fees: 0.1 },
    { ts: 4000, action: "Buy", qty: 1, price: 31204, commission: 0.62, fees: 0.1 },
  ];
  const r = pairManualGroup(fills);
  assert.equal(r.side, "short");
  assert.equal(r.pnlUsd, -9.44); // −4 pts × $2 = −$8 − $1.44 real fees
});

test("nyDay maps an epoch ms to the New York date", () => {
  __resetManualDetectForTest();
  // 2026-10-12 18:30 UTC = 14:30 EDT
  assert.equal(nyDay(Date.parse("2026-10-12T18:30:00Z")), "2026-10-12");
  // 2026-10-13 01:00 UTC = 2026-10-12 21:00 EDT (still the 12th in NY)
  assert.equal(nyDay(Date.parse("2026-10-13T01:00:00Z")), "2026-10-12");
});
