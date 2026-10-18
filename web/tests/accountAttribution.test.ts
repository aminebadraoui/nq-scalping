import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountForDay,
  isRecentAccount,
  resolveAccount,
  shortAccount,
  ACCOUNT_TIMELINE,
} from "../lib/accountAttribution";

test("ACCOUNT_TIMELINE: the three known eras, oldest first, open-ended last", () => {
  assert.equal(ACCOUNT_TIMELINE.length, 3);
  assert.equal(ACCOUNT_TIMELINE[0].account, "MFFUSFREOD706880008");
  assert.equal(ACCOUNT_TIMELINE[1].account, "MFFUEVREOD706880009");
  assert.equal(ACCOUNT_TIMELINE[2].account, "DEMO2323960");
  assert.equal(ACCOUNT_TIMELINE[2].untilDay, "9999-12-31");
});

test("accountForDay: boundary days land on the documented account", () => {
  assert.equal(accountForDay("2026-10-01"), "MFFUSFREOD706880008");
  assert.equal(accountForDay("2026-10-14"), "MFFUSFREOD706880008");
  assert.equal(accountForDay("2026-10-15"), "MFFUEVREOD706880009");
  assert.equal(accountForDay("2026-10-16"), "DEMO2323960");
  assert.equal(accountForDay("2026-10-31"), "DEMO2323960");
});

test("resolveAccount: fire-time stamp always wins", () => {
  const r = resolveAccount("MFFUEVREOD706880006", "2026-10-18");
  assert.equal(r.account, "MFFUEVREOD706880006");
  assert.equal(r.source, "fire-time");
});

test("resolveAccount: empty/whitespace stamp falls back to timeline", () => {
  assert.deepEqual(resolveAccount("", "2026-10-15"), { account: "MFFUEVREOD706880009", source: "timeline" });
  assert.deepEqual(resolveAccount("   ", "2026-10-18"), { account: "DEMO2323960", source: "timeline" });
  assert.deepEqual(resolveAccount(undefined, "2026-10-14"), { account: "MFFUSFREOD706880008", source: "timeline" });
});

test("shortAccount: last 4 characters", () => {
  assert.equal(shortAccount("DEMO2323960"), "3960");
  assert.equal(shortAccount(""), "");
});

test("isRecentAccount: the fresh-eval + demo era", () => {
  assert.equal(isRecentAccount("MFFUEVREOD706880009"), true);
  assert.equal(isRecentAccount("DEMO2323960"), true);
  assert.equal(isRecentAccount("MFFUSFREOD706880008"), false);
  assert.equal(isRecentAccount("MFFUEVREOD706880006"), false);
});
