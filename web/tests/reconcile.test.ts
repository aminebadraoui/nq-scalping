/* Unit tests for order-level trade reconstruction (lib/reconcile.ts):
 * entries are top-level orders, exits come from child orders — the
 * 12:58/12:59 interleaving that broke the greedy matcher must never
 * mis-pair again. */
import { test } from "node:test";
import assert from "node:assert";
import {
  entryCandidates,
  selectEntries,
  childExitFills,
  fallbackExitFills,
  type OrderRow,
  type FillRow,
} from "../lib/reconcile";

const T0 = Date.parse("2026-10-02T16:53:00Z"); // 12:53 ET

// the real mis-pairing scenario, reconstructed from fills:
//  long entry 12:54:09 (Buy 9), its child exit 13:00:45 (Sell @ target)
//  short entry 12:59:09 (Sell 9), its child exit 12:59:43 (Buy @ target)
const ORDERS: OrderRow[] = [
  { id: "151", ts: T0 + 69_000, action: "Buy", parentId: null }, // long entry
  { id: "152", ts: T0 + 69_000, action: "Sell", parentId: "151" }, // long target
  { id: "172", ts: T0 + 6 * 60_000 + 9_000, action: "Sell", parentId: null }, // short entry
  { id: "173", ts: T0 + 6 * 60_000 + 9_000, action: "Buy", parentId: "172" }, // short target
];

const FILLS: FillRow[] = [
  { ts: T0 + 69_000, action: "Buy", qty: 9, price: 31079.5, orderId: "151", instrument: "MNQZ6", commission: 0, fees: 0 },
  { ts: T0 + 7 * 60_000 + 45_000, action: "Sell", qty: 9, price: 31086.25, orderId: "152", instrument: "MNQZ6", commission: 0, fees: 0 },
  { ts: T0 + 6 * 60_000 + 9_000, action: "Sell", qty: 9, price: 31070.25, orderId: "172", instrument: "MNQZ6", commission: 0, fees: 0 },
  { ts: T0 + 6 * 60_000 + 43_000, action: "Buy", qty: 9, price: 31062.75, orderId: "173", instrument: "MNQZ6", commission: 0, fees: 0 },
];

test("entryCandidates: top-level orders only, sorted by time", () => {
  const c = entryCandidates(ORDERS, FILLS);
  assert.deepEqual(c.map((x) => x.order.id), ["151", "172"]);
});

test("selectEntries: the long and short each claim their own entry", () => {
  const c = entryCandidates(ORDERS, FILLS);
  const used = new Set<string>();
  const long = selectEntries({ ts: T0 + 54_000, side: "long", contracts: 9 }, c, used);
  assert.deepEqual(long.map((x) => x.order.id), ["151"]);
  for (const e of long) used.add(e.order.id);
  const short = selectEntries({ ts: T0 + 6 * 60_000 + 9_000, side: "short", contracts: 9 }, c, used);
  assert.deepEqual(short.map((x) => x.order.id), ["172"]);
});

test("childExitFills: the long's exit is its CHILD fill, never the short's entry", () => {
  const c = entryCandidates(ORDERS, FILLS);
  const long = selectEntries({ ts: T0 + 54_000, side: "long", contracts: 9 }, c, new Set());
  const exits = childExitFills(long, ORDERS, FILLS);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].price, 31086.25); // the target fill, not 31070.25
});

test("scale-out: one signal matches two entry orders (bank + runner)", () => {
  const orders: OrderRow[] = [
    { id: "e1", ts: T0, action: "Buy", parentId: null },
    { id: "e2", ts: T0 + 500, action: "Buy", parentId: null },
  ];
  const fills: FillRow[] = [
    { ts: T0, action: "Buy", qty: 6, price: 100, orderId: "e1", instrument: "MNQZ6", commission: 0, fees: 0 },
    { ts: T0 + 500, action: "Buy", qty: 3, price: 100, orderId: "e2", instrument: "MNQZ6", commission: 0, fees: 0 },
  ];
  const c = entryCandidates(orders, fills);
  const picked = selectEntries({ ts: T0, side: "long", contracts: 9 }, c, new Set());
  assert.deepEqual(picked.map((x) => x.order.id), ["e1", "e2"]);
});

test("fallbackExitFills: bounded scan stops at the next entry", () => {
  const orders: OrderRow[] = [
    { id: "e1", ts: T0, action: "Sell", parentId: null },
    { id: "e2", ts: T0 + 5 * 60_000, action: "Buy", parentId: null },
  ];
  const fills: FillRow[] = [
    { ts: T0, action: "Sell", qty: 9, price: 200, orderId: "e1", instrument: "MNQZ6", commission: 0, fees: 0 },
    { ts: T0 + 60_000, action: "Buy", qty: 9, price: 198, orderId: "cover", instrument: "MNQZ6", commission: 0, fees: 0 },
    { ts: T0 + 5 * 60_000, action: "Buy", qty: 9, price: 197, orderId: "e2", instrument: "MNQZ6", commission: 0, fees: 0 },
  ];
  const c = entryCandidates(orders, fills);
  const picked = selectEntries({ ts: T0, side: "short", contracts: 9 }, c, new Set());
  const exits = fallbackExitFills(picked, fills, T0 + 5 * 60_000, 9, "MNQ");
  assert.equal(exits.length, 1);
  assert.equal(exits[0].orderId, "cover"); // never steals the next entry
});

import { assignEntries } from "../lib/reconcile";

test("assignEntries: the nearest signal wins — phantoms cannot steal entries", () => {
  // real card 12:19 (ts 12:20:22) and a phantom row (ts 12:18:27) both
  // compete for the same Sell entry at 12:20:23
  const orders: OrderRow[] = [{ id: "119", ts: T0 + 7 * 60_000 + 23_000, action: "Sell", parentId: null }];
  const fills: FillRow[] = [
    { ts: T0 + 7 * 60_000 + 23_000, action: "Sell", qty: 9, price: 31113.75, orderId: "119", instrument: "MNQZ6", commission: 0, fees: 0 },
  ];
  const signals = [
    { key: "phantom", ts: T0 + 5 * 60_000 + 27_000, side: "short" as const, contracts: 9 }, // 12:18:27
    { key: "real", ts: T0 + 7 * 60_000 + 22_000, side: "short" as const, contracts: 9 }, // 12:20:22
  ];
  const out = assignEntries(signals, entryCandidates(orders, fills));
  assert.deepEqual([...out.keys()], ["real"]);
  assert.deepEqual(out.get("real")!.map((x) => x.order.id), ["119"]);
});

test("assignEntries: scale-out assigns two entry orders to one card", () => {
  const orders: OrderRow[] = [
    { id: "e1", ts: T0, action: "Buy", parentId: null },
    { id: "e2", ts: T0 + 400, action: "Buy", parentId: null },
  ];
  const fills: FillRow[] = [
    { ts: T0, action: "Buy", qty: 6, price: 100, orderId: "e1", instrument: "MNQZ6", commission: 0, fees: 0 },
    { ts: T0 + 400, action: "Buy", qty: 3, price: 100, orderId: "e2", instrument: "MNQZ6", commission: 0, fees: 0 },
  ];
  const out = assignEntries([{ key: "s", ts: T0, side: "long", contracts: 9 }], entryCandidates(orders, fills));
  assert.deepEqual(out.get("s")!.map((x) => x.order.id), ["e1", "e2"]);
});
