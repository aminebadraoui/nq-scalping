import { test } from "node:test";
import assert from "node:assert/strict";
import {
  botEntry,
  buildEntries,
  accountRollup,
  entryAccounts,
  manualEntry,
  manualFeesUsd,
  manualNetUsd,
  etTime,
} from "../lib/journalEntries";

const bot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  signal_key: "sig|2026-10-17|long|09:41",
  day: "2026-10-17",
  time_et: "09:41",
  ts: 1_700_000_000_000,
  side: "long",
  contracts: 9,
  verdict: "RTH pullback …",
  status: "matched",
  result: "win",
  fill_entry: "31500.25",
  exit_avg: "31510.25",
  gross_usd: "180",
  commissions: "17.1",
  net_usd: "162.9",
  account: "DEMO2323960",
  ...over,
});

const manual = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "mff|1234",
  day: "2026-10-16",
  symbol: "MNQZ6",
  direction: "short",
  qty: 2,
  entry_price: "31500.00",
  exit_price: "31490.00",
  pnl_usd: "20.00",
  pnl_net_usd: "16.20",
  fees_usd: "3.80",
  entry_at: "2026-10-16T15:02:00.000Z",
  exit_at: "2026-10-16T15:11:00.000Z",
  matched_signal: null,
  account: "DEMO2323960",
  ...over,
});

test("botEntry: explicit origin bot, fire-time account, matched anatomy", () => {
  const e = botEntry(bot());
  assert.equal(e.origin, "bot");
  assert.equal(e.key, "sig|2026-10-17|long|09:41");
  assert.equal(e.account, "DEMO2323960");
  assert.equal(e.accountSource, "fire-time");
  assert.equal(e.status, "matched");
  assert.equal(e.netUsd, 162.9);
  assert.equal(e.feesUsd, 17.1);
  assert.equal(e.family, "session_continuation");
  assert.equal(e.symbol, "");
});

test("botEntry: unexecuted rows carry zero money and keep the signal", () => {
  const e = botEntry(bot({ status: "unexecuted", result: "", fill_entry: null, exit_avg: null, gross_usd: "0", net_usd: "0" }));
  assert.equal(e.status, "unexecuted");
  assert.equal(e.result, "");
  assert.equal(e.netUsd, 0);
});

test("botEntry: legacy row without a stamp gets the timeline account", () => {
  const e = botEntry(bot({ account: "", day: "2026-10-15" }));
  assert.equal(e.account, "MFFUEVREOD706880009");
  assert.equal(e.accountSource, "timeline");
});

test("manualEntry: explicit origin manual, net P&L preferred, ET time from entry_at", () => {
  const e = manualEntry(manual());
  assert.equal(e.origin, "manual");
  assert.equal(e.key, "mff|1234");
  assert.equal(e.symbol, "MNQZ6");
  assert.equal(e.side, "short");
  assert.equal(e.contracts, 2);
  assert.equal(e.grossUsd, 20);
  assert.equal(e.netUsd, 16.2);
  assert.equal(e.feesUsd, 3.8);
  assert.equal(e.result, "win");
  assert.equal(e.timeET, "11:02"); // 15:02Z = 11:02 ET (EDT)
});

test("manualNetUsd/manualFeesUsd: net present wins; fees derived when absent", () => {
  assert.equal(manualNetUsd({ pnl_usd: "20", pnl_net_usd: "16.2" }), 16.2);
  assert.equal(manualNetUsd({ pnl_usd: "20" }), 20);
  assert.equal(manualFeesUsd({ pnl_usd: "20", pnl_net_usd: "16.2" }), 3.8);
  assert.equal(manualFeesUsd({ pnl_usd: "20" }), 0);
});

test("etTime: epoch ms → HH:mm New York", () => {
  // 2026-10-16T15:02:00Z = 11:02 EDT
  assert.equal(etTime(Date.parse("2026-10-16T15:02:00.000Z")), "11:02");
  assert.equal(etTime(NaN), "");
  assert.equal(etTime(0), "");
});

test("buildEntries: unified list, newest first, bot+manual interleaved", () => {
  const entries = buildEntries([bot({ ts: 1_000 }), bot({ ts: 3_000 })], [manual({ entry_at: "1970-01-01T00:00:00.500Z" })]);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].ts, 3_000);
  assert.equal(entries[2].origin, "manual");
  assert.deepEqual(
    new Set(entries.map((e) => e.origin)),
    new Set(["bot", "manual"]),
  );
});

test("buildEntries: manual rows with matched_signal are caller-filtered, not entries themselves", () => {
  // the contract: buildEntries maps what it is given; callers pass
  // matched_signal-null rows only. Rows with matched_signal are bot
  // provenance — verified here that they'd still map as manual origin
  // if passed, so the API filter is the guard.
  const e = manualEntry({ ...manual(), matched_signal: "sig1" });
  assert.equal(e.origin, "manual");
});

test("accountRollup: per-account bot/manual net and totals", () => {
  const entries = buildEntries(
    [
      bot({ net_usd: "100", gross_usd: "110", commissions: "10" }),
      bot({ net_usd: "-40", gross_usd: "-30", commissions: "10", result: "loss", day: "2026-10-16", account: "MFFUEVREOD706880009" }),
    ],
    [manual({ pnl_net_usd: "16.2", pnl_usd: "20" })],
  );
  const roll = accountRollup(entries);
  assert.equal(roll.length, 2);
  const demo = roll.find((r) => r.account === "DEMO2323960")!;
  const eval9 = roll.find((r) => r.account === "MFFUEVREOD706880009")!;
  assert.equal(demo.botN, 1);
  assert.equal(demo.manualN, 1);
  assert.equal(demo.botNet, 100);
  assert.equal(demo.manualNet, 16.2);
  assert.equal(demo.net, 116.2);
  assert.equal(eval9.botN, 1);
  assert.equal(eval9.botNet, -40);
  assert.equal(eval9.manualNet, 0);
});

test("accountRollup/entryAccounts: unexecuted rows never count money", () => {
  const entries = buildEntries([bot({ status: "unexecuted", net_usd: "0", gross_usd: "0" })], []);
  const roll = accountRollup(entries);
  assert.equal(roll[0].botN, 0);
  assert.equal(roll[0].net, 0);
  assert.deepEqual(entryAccounts(entries), ["DEMO2323960"]);
});
