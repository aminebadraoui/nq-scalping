/* Unit tests for lib/execTracker.ts — the live execution ledger:
 * family labels, the reconcile-identical P&L math, and the
 * register → fill → close state machine over the in-memory ring. */

import { test } from "node:test";
import assert from "node:assert";
import {
  commissionPerSide,
  computeExecPnl,
  familyOfLabel,
  execTradesMemory,
  getExecTrades,
  trackExecClose,
  trackExecFail,
  trackExecFill,
  trackExecRegister,
  __resetExecTrackerForTest,
} from "../lib/execTracker";

// never touch a real database from the test suite
process.env.DATABASE_URL = "";

test("familyOfLabel maps the watcher label prefixes", () => {
  assert.equal(familyOfLabel("sweep-reclaim long"), "sweep_reclaim");
  assert.equal(familyOfLabel("momentum short"), "momentum");
  assert.equal(familyOfLabel("rth short"), "rth");
  assert.equal(familyOfLabel("open-drive long"), "open_drive");
  assert.equal(familyOfLabel("pullback-ticket short"), "pullback_ticket");
  assert.equal(familyOfLabel("unknown-thing long"), "unknown-thing");
  assert.equal(familyOfLabel(""), "other");
});

test("computeExecPnl matches the reconcile math (long winner)", () => {
  // entry 31100.00, exit 31102.50, 5 contracts → +2.5 pts × 5 × $2 = $25.00
  const pnl = computeExecPnl({
    dir: "long",
    contracts: 5,
    entry: 31100.0,
    exitAvg: 31102.5,
    entryFills: [{ ts: 1, action: "Buy", qty: 5, price: 31100.0 }],
    exitFills: [{ ts: 2, action: "Sell", qty: 5, price: 31102.5 }],
    realFees: 0,
  });
  assert.equal(pnl.pts, 12.5); // total points across the contracts
  assert.equal(pnl.grossUsd, 25);
  // 10 fill rows × $0.95/side fallback
  assert.equal(pnl.feesUsd, 9.5);
  assert.equal(pnl.netUsd, 15.5);
  assert.equal(pnl.result, "win");
});

test("computeExecPnl: short loss with real fees", () => {
  const pnl = computeExecPnl({
    dir: "short",
    contracts: 3,
    entry: 31200.0,
    exitAvg: 31204.0,
    entryFills: [{ ts: 1, action: "Sell", qty: 3, price: 31200.0 }],
    exitFills: [{ ts: 2, action: "Buy", qty: 3, price: 31204.0 }],
    realFees: 2.4,
  });
  assert.equal(pnl.pts, -12);
  assert.equal(pnl.grossUsd, -24);
  assert.equal(pnl.feesUsd, 2.4); // real fees win over the fallback
  assert.equal(pnl.netUsd, -26.4);
  assert.equal(pnl.result, "loss");
});

test("computeExecPnl: partial exit never inflates pts past the entry qty", () => {
  const pnl = computeExecPnl({
    dir: "long",
    contracts: 5,
    entry: 31100.0,
    exitAvg: 31101.0,
    entryFills: [{ ts: 1, action: "Buy", qty: 5, price: 31100.0 }],
    exitFills: [{ ts: 2, action: "Sell", qty: 2, price: 31101.0 }],
    realFees: 0,
  });
  assert.equal(pnl.pts, 5); // 1 pt × 5 entered (not × 2 exited)
  assert.equal(pnl.grossUsd, 10);
});

test("computeExecPnl: null exit stays open (no result)", () => {
  const pnl = computeExecPnl({
    dir: "long",
    contracts: 1,
    entry: 31100.0,
    exitAvg: null,
    entryFills: [],
    exitFills: [],
    realFees: 0,
  });
  assert.equal(pnl.result, "");
  assert.equal(pnl.netUsd, 0);
});

test("register → fill → close state machine over the memory ring", async () => {
  __resetExecTrackerForTest();
  trackExecRegister({
    key: "reclaim|2026-10-12|long|09:41",
    ts: 1_700_000_000_000,
    day: "2026-10-12",
    label: "sweep-reclaim long",
    dir: "long",
    contracts: 5,
    entry: 31100,
    stop: 31095,
    target: 31110,
    timeET: "09:41",
    signalId: "sig-1",
  });
  let rows = execTradesMemory();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "placed");
  assert.equal(rows[0].family, "sweep_reclaim");

  trackExecFill(
    "reclaim|2026-10-12|long|09:41",
    { ts: 1_700_000_001_000, action: "Buy", qty: 5, price: 31100.25 },
    [{ ts: 1_700_000_001_000, action: "Buy", qty: 5, price: 31100.25, orderId: "tradovate-ord-77" }],
  );
  rows = execTradesMemory();
  assert.equal(rows[0].status, "filled");
  assert.equal(rows[0].fillEntry, 31100.25);
  assert.equal(rows[0].orderId, "tradovate-ord-77");

  trackExecClose("reclaim|2026-10-12|long|09:41", {
    entry: 31100,
    dir: "long",
    contracts: 5,
    exitFills: [{ ts: 1_700_000_060_000, action: "Sell", qty: 5, price: 31102.5 }],
    realFees: 3.1,
  });
  rows = execTradesMemory();
  assert.equal(rows[0].status, "closed");
  assert.equal(rows[0].exitAvg, 31102.5);
  // (31102.5 − 31100.25) × 5 = 11.25 pts × $2 = $22.50 gross − $3.10 = $19.40
  assert.equal(rows[0].pts, 11.25);
  assert.equal(rows[0].grossUsd, 22.5);
  assert.equal(rows[0].netUsd, 19.4);
  assert.equal(rows[0].result, "win");

  const merged = await getExecTrades(10); // DB disabled under tests → memory only
  assert.equal(merged.length, 1);
  assert.equal(merged[0].signalId, "sig-1");
});

test("trackExecFail marks the row failed; unknown keys are no-ops", () => {
  __resetExecTrackerForTest();
  trackExecRegister({
    key: "mom|2026-10-12|long|10:00",
    ts: 1,
    day: "2026-10-12",
    label: "momentum long",
    dir: "long",
    contracts: 2,
    entry: 31000,
    stop: 30990,
    target: 31020,
    timeET: "10:00",
  });
  trackExecFail("mom|2026-10-12|long|10:00", "not flat — an MNQ position is open");
  assert.equal(execTradesMemory()[0].status, "failed");
  trackExecFail("nope", "x"); // must not throw
});

test("commissionPerSide honors the env override", () => {
  assert.equal(commissionPerSide({}), 0.95);
  assert.equal(commissionPerSide({ CT_COMMISSION_PER_SIDE: "1.20" }), 1.2);
  assert.equal(commissionPerSide({ CT_COMMISSION_PER_SIDE: "junk" }), 0.95);
});
