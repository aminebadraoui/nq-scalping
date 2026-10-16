/* Unit tests for lib/ctAccount.ts — the single CrossTrade read layer.
 * Verifies cache windows, fail-closed snapshot caching, account-row
 * matching, and fill parsing — the contract every consumer relies on. */

import { test } from "node:test";
import assert from "node:assert";
import {
  accountRow,
  classifyCtRateLimit,
  configuredAccount,
  ctApplyWsFrame,
  ctFetch,
  ctFills,
  ctOrders,
  ctPenaltyActive,
  ctPositions,
  ctSnapshot,
  ctSnapshotDisplay,
  ctWsHeartbeat,
  ctWsMarkResync,
  isCtRateLimited,
  parseRetryAfterMs,
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

/* ------------ CrossTrade pacing transport (2026-10-12 broker_rate_limited fix) ------------ */

const textFetch = (payload: unknown, status = 200): typeof fetch =>
  (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
      json: async () => payload,
    }) as unknown as Response) as unknown as typeof fetch;

test("isCtRateLimited detects the vendor pacing shapes", () => {
  assert.equal(isCtRateLimited(429, ""), true);
  assert.equal(isCtRateLimited(200, '{"success":false,"error":"broker_rate_limited","detail":"…"}'), true);
  assert.equal(isCtRateLimited(200, '{"success":false,"error":"unknown_account"}'), false);
  assert.equal(isCtRateLimited(400, ""), false);
  assert.equal(isCtRateLimited(503, ""), false); // 503 rides retryOn503, not the body check
});

test("ctFetch retries a 429 pacing refusal and returns the eventual read", async () => {
  __resetCtAccountForTest();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return calls === 1 ? textFetch("paced", 429)(input, init) : textFetch({ ok: true }, 200)(input, init);
  };
  const res = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 2, backoffBaseMs: 1 }, fetchFn);
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).ok, true);
});

test("ctFetch retries a success:false broker_rate_limited body (HTTP 200)", async () => {
  __resetCtAccountForTest();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return calls === 1
      ? textFetch({ success: false, error: "broker_rate_limited", detail: "pacing" }, 200)(input, init)
      : textFetch({ success: true, data: [] }, 200)(input, init);
  };
  const res = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 1, backoffBaseMs: 1 }, fetchFn);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(res.text).success, true);
});

test("ctFetch never retries non-pacing failures (400 passes through once)", async () => {
  __resetCtAccountForTest();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return textFetch({ error: "unknown_account" }, 400)(input, init);
  };
  const res = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 3, backoffBaseMs: 1 }, fetchFn);
  assert.equal(calls, 1);
  assert.equal(res.status, 400);
});

test("ctFetch returns the final pacing refusal once the retry budget is spent", async () => {
  __resetCtAccountForTest();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return textFetch({ success: false, error: "broker_rate_limited" }, 200)(input, init);
  };
  const res = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 2, backoffBaseMs: 1 }, fetchFn);
  assert.equal(calls, 3);
  assert.match(res.text, /broker_rate_limited/);
});

test("ctFetch does not retry a 503 on writes unless retryOn503 is set", async () => {
  __resetCtAccountForTest();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return textFetch("unavailable", 503)(input, init);
  };
  const write = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 2, backoffBaseMs: 1 }, fetchFn);
  assert.equal(calls, 1); // a write must never re-POST on an ambiguous 503
  const read = await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 1, backoffBaseMs: 1, retryOn503: true }, fetchFn);
  assert.equal(calls, 3);
  assert.equal(read.status, 503);
});

test("ctFetch spaces calls by the configured min gap (no bursts)", async () => {
  __resetCtAccountForTest({ gapMs: 30 });
  const times: number[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    times.push(Date.now());
    return textFetch("ok", 200)(input, init);
  };
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[1] - times[0] >= 25, `gap1 ${times[1] - times[0]}ms`);
  assert.ok(times[2] - times[1] >= 25, `gap2 ${times[2] - times[1]}ms`);
});

test("ctPositions rides out a broker_rate_limited then returns the book", async () => {
  __resetCtAccountForTest({ backoffBaseMs: 1 });
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return calls <= 2
      ? textFetch({ success: false, error: "broker_rate_limited" }, 200)(input, init)
      : textFetch({ success: true, data: [{ netPos: 0 }] }, 200)(input, init);
  };
  const rows = await ctPositions({ fetchFn });
  assert.equal(calls, 3); // 2 pacing retries inside ctFetch, then the read
  assert.deepEqual(rows, [{ netPos: 0 }]);
});

test("ctSnapshot rides out a pacing refusal before the degraded-shape loop", async () => {
  __resetCtAccountForTest({ backoffBaseMs: 1 });
  setEnv(BASE_ENV);
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    if (calls === 1) return textFetch({ success: false, error: "broker_rate_limited" }, 200)(input, init);
    return textFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 42.5 }] }, 200)(input, init);
  };
  const snap = await ctSnapshot({ fetchFn, retryDelayMs: 0 });
  assert.equal(calls, 2); // one pacing retry inside ctFetch, then the usable read
  assert.equal(snap.accounts?.[0]?.netLiq, 50100);
  assert.equal(ctSnapshotDisplay()?.accounts?.[0]?.realizedPnl, 42.5);
});

/* ---- vendor retryAfter + penalty cooldown (2026-10-12 doc contract) ---- */

test("classifyCtRateLimit names the three vendor shapes", () => {
  assert.equal(classifyCtRateLimit(429, '{"success":false,"error":"broker_rate_limited","detail":"…"}'), "broker");
  assert.equal(classifyCtRateLimit(429, '{"success":false,"error":"rate_limited","retryAfter":2}'), "ct_pacing");
  assert.equal(classifyCtRateLimit(429, '{"error":"snapshot_refresh_pending","retryAfter":1}'), "snapshot_pending");
  assert.equal(classifyCtRateLimit(400, "{}"), null);
});

test("parseRetryAfterMs reads the body field and the header", () => {
  assert.equal(parseRetryAfterMs(429, '{"retryAfter": 2}', null), 2000);
  assert.equal(parseRetryAfterMs(429, '{"retryAfter": 0.5}', null), 500);
  assert.equal(parseRetryAfterMs(429, "{}", { get: (k) => (k === "retry-after" ? "3" : null) }), 3000);
  assert.equal(parseRetryAfterMs(429, "{}", null), null);
});

test("ctFetch honors the vendor retryAfter instead of the fixed backoff", async () => {
  __resetCtAccountForTest();
  const t0 = Date.now();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return calls === 1
      ? textFetch({ success: false, error: "rate_limited", retryAfter: 0.04 }, 429)(input, init)
      : textFetch({ ok: true }, 200)(input, init);
  };
  const res = await ctFetch(
    "https://app.crosstrade.io/x",
    {},
    { extraRetries: 1, backoffBaseMs: 1, retryAfterCapMs: 100 },
    fetchFn,
  );
  const elapsed = Date.now() - t0;
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
  assert.ok(elapsed >= 35, `slept only ${elapsed}ms — retryAfter not honored`);
});

test("ctFetch caps the retryAfter wait so a long penalty cannot stall a card", async () => {
  __resetCtAccountForTest();
  const t0 = Date.now();
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    calls++;
    return calls === 1
      ? textFetch({ success: false, error: "broker_rate_limited", retryAfter: 60 }, 429)(input, init)
      : textFetch({ ok: true }, 200)(input, init);
  };
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 1, backoffBaseMs: 1, retryAfterCapMs: 60 }, fetchFn);
  const elapsed = Date.now() - t0;
  assert.equal(calls, 2);
  assert.ok(elapsed < 2000, `took ${elapsed}ms — the 60s hint must be capped`);
});

test("a surviving pacing refusal opens a penalty cooldown that pauses the polls", async () => {
  __resetCtAccountForTest({ penaltyMinMs: 50, penaltyMaxMs: 100 });
  setEnv(BASE_ENV);
  // exhaust a broker refusal → penalty opens
  const refused: typeof fetch = (input, init) => textFetch({ success: false, error: "broker_rate_limited", retryAfter: 60 }, 429)(input, init);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0, backoffBaseMs: 1 }, refused);
  assert.equal(ctPenaltyActive(), true);
  // polls must serve their last-known state WITHOUT fetching
  let pollCalls = 0;
  const counting: typeof fetch = (input, init) => {
    pollCalls++;
    return textFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 42.5 }] }, 200)(input, init);
  };
  await ctSnapshot({ fetchFn: counting, retryDelayMs: 0 });
  await ctFills({ force: true, fetchFn: counting });
  await ctPositions({ fetchFn: counting });
  const ord = await ctOrders({ fetchFn: counting });
  assert.equal(pollCalls, 0, "polls fetched during the penalty cooldown");
  assert.deepEqual(ord, { ok: false, orders: [] });
  // after the cooldown passes, polls fetch again
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(ctPenaltyActive(), false);
  await ctSnapshot({ fetchFn: counting, retryDelayMs: 0 });
  assert.equal(pollCalls, 1);
});

test("ctSnapshot during a penalty serves the last good cache, null-caches without one", async () => {
  __resetCtAccountForTest({ penaltyMinMs: 80, penaltyMaxMs: 100 });
  setEnv(BASE_ENV);
  const good: typeof fetch = (input, init) => textFetch({ accounts: [{ name: ACCT, netLiq: 50100, realizedPnl: 42.5 }] }, 200)(input, init);
  await ctSnapshot({ fetchFn: good, retryDelayMs: 0 }); // warm the cache
  const refused: typeof fetch = (input, init) => textFetch({ success: false, error: "broker_rate_limited", retryAfter: 60 }, 429)(input, init);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0, backoffBaseMs: 1 }, refused);
  let calls = 0;
  const counting: typeof fetch = (input, init) => {
    calls++;
    return textFetch({ accounts: [{ name: ACCT, netLiq: 99999, realizedPnl: 1 }] }, 200)(input, init);
  };
  const snap = await ctSnapshot({ fetchFn: counting, retryDelayMs: 0 });
  assert.equal(calls, 0);
  assert.equal(snap.accounts?.[0]?.netLiq, 50100); // the cached truth, not a fetch
  // cold caches (no good snapshot) still fail closed during a penalty
  __resetCtAccountForTest({ penaltyMinMs: 80, penaltyMaxMs: 100 });
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0, backoffBaseMs: 1 }, refused);
  const cold = await ctSnapshot({ fetchFn: counting, retryDelayMs: 0 });
  assert.equal(cold.accounts, null);
});

/* ---- WebSocket state mirror (frames are free, polls serve them) ---- */

test("ctOrders/ctPositions serve the WS mirror once hydrated, REST re-seeds after resync", async () => {
  __resetCtAccountForTest();
  setEnv(BASE_ENV);
  let restCalls = 0;
  const restFetch: typeof fetch = (input, init) => {
    restCalls++;
    const url = String(input);
    if (url.includes("/orders")) return textFetch({ success: true, data: [{ id: "o1", ordStatus: "Working", instrument: "MNQZ6" }] }, 200)(input, init);
    return textFetch({ success: true, data: [{ id: "p1", netPos: 3, contractName: "MNQZ6" }] }, 200)(input, init);
  };
  // frames before hydration are ignored (a half-seeded mirror lies)
  ctApplyWsFrame("order", { id: "ghost", ordStatus: "Working" });
  const ord1 = await ctOrders({ fetchFn: restFetch });
  assert.equal(restCalls, 1);
  assert.equal(ord1.orders.length, 1); // REST seed, ghost ignored
  // fresh mirror: frames flow, polls stop fetching
  ctWsHeartbeat();
  ctApplyWsFrame("order", { id: "o2", ordStatus: "Working", instrument: "MNQZ6" });
  const ord2 = await ctOrders({ fetchFn: restFetch });
  assert.equal(restCalls, 1, "mirror should serve without REST");
  assert.equal(ord2.orders.length, 2);
  const pos1 = await ctPositions({ fetchFn: restFetch });
  assert.equal(restCalls, 2); // positions mirror not yet hydrated → one REST seed
  assert.equal(pos1?.[0]?.netPos, 3);
  ctApplyWsFrame("position", { id: "p1", netPos: 2, contractName: "MNQZ6" });
  const pos2 = await ctPositions({ fetchFn: restFetch });
  assert.equal(restCalls, 2, "positions mirror should serve without REST");
  assert.equal(pos2?.[0]?.netPos, 2);
  // resync: hydration drops → the next read re-seeds over REST
  ctWsMarkResync();
  await ctOrders({ fetchFn: restFetch });
  assert.equal(restCalls, 3);
});

/* ---- broker-refusal gap escalation (2026-10-16, demo-login budget) ---- */

test("ctFetch widens the call spacing after a broker refusal, decaying after the window", async () => {
  __resetCtAccountForTest({ gapMs: 5, brokerGap1Ms: 40, brokerGap2Ms: 80, escalateWindowMs: 150 });
  const times: number[] = [];
  let first = true;
  const fetchFn: typeof fetch = (input, init) => {
    times.push(Date.now());
    if (first) {
      first = false;
      return textFetch({ success: false, error: "broker_rate_limited" }, 429)(input, init);
    }
    return textFetch("ok", 200)(input, init);
  };
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[1] - times[0] >= 35, `escalated gap ${times[1] - times[0]}ms`);
  await new Promise((r) => setTimeout(r, 180)); // window passes
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn); // clean call resets
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[3] - times[2] < 30, `decayed gap ${times[3] - times[2]}ms`);
});

test("two broker refusals escalate the spacing to the second tier", async () => {
  __resetCtAccountForTest({ gapMs: 5, brokerGap1Ms: 40, brokerGap2Ms: 80, escalateWindowMs: 1000 });
  const times: number[] = [];
  let refusals = 0;
  const fetchFn: typeof fetch = (input, init) => {
    times.push(Date.now());
    if (refusals < 2) {
      refusals++;
      return textFetch({ success: false, error: "broker_rate_limited" }, 429)(input, init);
    }
    return textFetch("ok", 200)(input, init);
  };
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[1] - times[0] >= 35, `tier1 gap ${times[1] - times[0]}ms`);
  assert.ok(times[2] - times[1] >= 75, `tier2 gap ${times[2] - times[1]}ms`);
});

test("a ct_pacing refusal does NOT widen the spacing (cheap governor hint)", async () => {
  __resetCtAccountForTest({ gapMs: 5, brokerGap1Ms: 40, brokerGap2Ms: 80, escalateWindowMs: 1000 });
  const times: number[] = [];
  let first = true;
  const fetchFn: typeof fetch = (input, init) => {
    times.push(Date.now());
    if (first) {
      first = false;
      return textFetch({ success: false, error: "rate_limited", retryAfter: 1 }, 429)(input, init);
    }
    return textFetch("ok", 200)(input, init);
  };
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0, backoffBaseMs: 1 }, fetchFn);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[1] - times[0] < 30, `no escalation ${times[1] - times[0]}ms`);
});

test("a broker refusal on the first attempt escalates even when the retry succeeds (the live pattern)", async () => {
  __resetCtAccountForTest({ gapMs: 5, brokerGap1Ms: 40, brokerGap2Ms: 80, escalateWindowMs: 1000, backoffBaseMs: 1 });
  setEnv(BASE_ENV);
  const times: number[] = [];
  let calls = 0;
  const fetchFn: typeof fetch = (input, init) => {
    times.push(Date.now());
    calls++;
    return calls === 1
      ? textFetch({ success: false, error: "broker_rate_limited" }, 429)(input, init)
      : textFetch({ success: true, data: [] }, 200)(input, init);
  };
  const rows = await ctPositions({ fetchFn }); // attempt 1 paced → retry succeeds
  assert.deepEqual(rows, []);
  await ctFetch("https://app.crosstrade.io/x", {}, { extraRetries: 0 }, fetchFn);
  assert.ok(times[times.length - 1] - times[1] >= 35, `escalated after retry-success call (${times[times.length - 1] - times[1]}ms)`);
});
