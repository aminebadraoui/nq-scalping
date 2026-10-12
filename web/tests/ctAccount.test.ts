/* Unit tests for lib/ctAccount.ts — the single CrossTrade read layer.
 * Verifies cache windows, fail-closed snapshot caching, account-row
 * matching, and fill parsing — the contract every consumer relies on. */

import { test } from "node:test";
import assert from "node:assert";
import {
  accountRow,
  configuredAccount,
  ctFills,
  ctOrders,
  ctPositions,
  ctSnapshot,
  ctSnapshotDisplay,
  __resetCtAccountForTest,
  type CtSnapshotAccount,
} from "../lib/ctAccount";

const KEY = "test-key";
const ACCT = "MFFUEVREOD1234";

const BASE_ENV = { CROSSTRADE_URL: "https://app.crosstrade.io/v1/send/u/c", CROSSTRADE_KEY: KEY, CROSSTRADE_ACCOUNT: ACCT };

function setEnv(env: Record<string, string>) {
  process.env.CROSSTRADE_URL = env.CROSSTRADE_URL ?? "";
  process.env.CROSSTRADE_KEY = env.CROSSTRADE_KEY ?? "";
  process.env.CROSSTRADE_ACCOUNT = env.CROSSTRADE_ACCOUNT ?? "";
}

const jsonFetch = (payload: unknown, status = 200): typeof fetch =>
  (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response) as unknown as typeof fetch;

const failFetch = (status = 500): typeof fetch =>
  (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({ ok: false, status, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;

test("configuredAccount returns the linked account name", () => {
  setEnv(BASE_ENV);
  assert.equal(configuredAccount(), ACCT);
});

test("accountRow matches by name case-insensitively, null when absent", () => {
  const snap = {
    at: Date.now(),
    accounts: [
      { name: "mffuevreod1234", netLiq: 50100, realizedPnl: 42.5 },
      { name: "OTHER", netLiq: 1 },
    ] as CtSnapshotAccount[],
  };
  assert.equal(accountRow(snap, ACCT)?.netLiq, 50100);
  assert.equal(accountRow(snap, "missing"), null);
  assert.equal(accountRow({ at: 0, accounts: null }, ACCT), null);
});

test("ctSnapshot caches within the 30s window and null-caches on failure", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: 50000, realizedPnl: 0 }] })(input, init);
  };
  const a = await ctSnapshot({ fetchFn });
  assert.equal(a.accounts?.[0]?.netLiq, 50000);
  const b = await ctSnapshot({ fetchFn }); // cached — no second call
  assert.equal(calls, 1);
  assert.equal(b.at, a.at);
  assert.equal(ctSnapshotDisplay()?.accounts?.[0]?.netLiq, 50000);

  // failure → null-cached (fail closed), display keeps the last good value
  __resetCtAccountForTest();
  const bad = await ctSnapshot({ fetchFn: failFetch(), retryDelayMs: 0 });
  assert.equal(bad.accounts, null);
  assert.equal(ctSnapshotDisplay(), null);
});

test("ctSnapshot retries a degraded read (null balances) and resolves the first usable row", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    // attempt 1: the vendor's refresh-flap shape — row present, balances null
    if (calls === 1) return jsonFetch({ accounts: [{ name: ACCT, netLiq: null, realizedPnl: null, openPnl: 0 }] })(input, init);
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 42.5 }] })(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(snap.accounts?.[0]?.netLiq, 50100);
  assert.equal(ctSnapshotDisplay()?.accounts?.[0]?.realizedPnl, 42.5);
});

test("ctSnapshot retries after a hard fetch failure and resolves on a later attempt", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    if (calls === 1) return failFetch(503)(input, init);
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 42.5 }] })(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(snap.accounts?.[0]?.netLiq, 50100);
});

test("ctSnapshot null-caches only after EVERY attempt is degraded (fail closed)", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const degraded: typeof fetch = (input, init) => {
    calls++;
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: null, realizedPnl: null }] })(input, init);
  };
  const snap = await ctSnapshot({ fetchFn: degraded, retryDelayMs: 0 });
  assert.equal(calls, 3);
  assert.equal(snap.accounts, null);
  assert.equal(ctSnapshotDisplay(), null);
});

test("ctSnapshot null-caches when every attempt hard-fails", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return failFetch(500)(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 3);
  assert.equal(snap.accounts, null);
});

test("ctSnapshot retries when the configured account row is missing from the list", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    if (calls <= 2) return jsonFetch({ accounts: [{ name: "SOMEONE_ELSE", netLiq: 5, realizedPnl: 0 }] })(input, init);
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 0 }] })(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 3);
  assert.equal(snap.accounts?.[0]?.netLiq, 50100);
});

test("ctSnapshot does not retry a usable first read", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return jsonFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 0 }] })(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(snap.accounts?.[0]?.netLiq, 50100);
});

test("ctFills parses orderId/instrument/fees and falls back to the last good list", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  const fetchFn: typeof fetch = (input, init) =>
    jsonFetch({
      data: [
        {
          data: [
            { timestamp: "2026-10-12T13:41:00Z", action: "Buy", qty: 5, price: 31100.5, orderId: "ord-1", instrument: "MNQZ6", commission: 1.25, fees: 0.1 },
            { timestamp: "garbage", action: "Sell", qty: 1, price: 1 },
          ],
        },
      ],
    })(input, init);
  const fills = await ctFills({ fetchFn });
  assert.equal(fills?.length, 1); // the unparseable timestamp is skipped
  assert.equal(fills?.[0].orderId, "ord-1");
  assert.equal(fills?.[0].instrument, "MNQZ6");
  assert.equal(fills?.[0].commission, 1.25);
  const again = await ctFills({ fetchFn }); // cached 5s
  assert.deepEqual(again, fills);
  const failed = await ctFills({ force: true, fetchFn: failFetch() });
  assert.deepEqual(failed, fills); // last good list survives a failed refresh
});

test("ctPositions null-caches on failure and returns rows when ok", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  // cold failure → null (callers treat unreadable as "keep waiting")
  const bad = await ctPositions({ fetchFn: failFetch() });
  assert.equal(bad, null);
  __resetCtAccountForTest();
  const okFetch: typeof fetch = (input, init) => jsonFetch({ success: true, data: [{ netPos: 3, instrument: "MNQZ6" }] })(input, init);
  const rows = await ctPositions({ fetchFn: okFetch });
  assert.equal(rows?.length, 1);
});

test("ctOrders returns ok=false with empty list on any failure", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  const bad = await ctOrders({ fetchFn: failFetch() });
  assert.deepEqual(bad, { ok: false, orders: [] });
  const ok = await ctOrders({ fetchFn: (input, init) => jsonFetch({ success: true, data: [{ id: 1 }] })(input, init) });
  assert.deepEqual(ok, { ok: true, orders: [{ id: 1 }] });
});
