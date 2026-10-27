/* Regression (2026-10-26 audit): a resting limit still pending when the
 * signal window closes (16:00 ET) was re-cancelled on EVERY 5s watcher
 * tick for the whole halt/weekend (1,439 cancel calls in one 2h halt)
 * because the closed-window branch never dropped the card. Own file: it
 * mocks fetch for the whole process. */
import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  EXECUTE_LIVE: "1", CROSSTRADE_URL: "https://app.crosstrade.io/x", CROSSTRADE_KEY: "k",
  CROSSTRADE_ACCOUNT: "A", TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_CHAT_ID: "1", DAYBOOK_OFF: "1",
});
delete process.env.DATABASE_URL;

const T0 = Date.parse("2026-10-27T15:59:30-04:00");
const HALT = Date.parse("2026-10-27T16:00:00-04:00");
const intent = { symbol: "NQZ26", dir: "long" as const, contracts: 2, entry: 20000, stop: 19990, target: 20010, timeET: "15:59" };

async function runHalt(cancelOk: boolean): Promise<{ cancels: number; pending: string[] }> {
  const ew = await import("../lib/execWatch");
  const ct = await import("../lib/ctAccount");
  ew.__resetExecWatchForTest();
  let cancels = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => {
    const url = String(u);
    let body: unknown = { success: true, data: [] };
    if (url.endsWith("/cancel")) {
      cancels++;
      body = cancelOk ? { success: true, data: [] } : { success: false, error: "cancel refused" };
    } else if (url.endsWith("/orders")) {
      // the order is still working when the cancel fails
      body = { success: true, data: cancelOk ? [] : [{ orderId: "oid-1", ordStatus: "Working" }] };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
  }) as typeof fetch;
  try {
    ew.registerExpectation({ key: "rth|x", ts: T0, label: "rth long limit", intent, scaleOut: false, limit: { orderId: "oid-1", price: 20000, expireAtMs: T0 + 50_000 } } as never);
    for (let s = 5; s <= 7195; s += 5) {
      ct.__resetCtAccountForTest({ backoffBaseMs: 1 });
      await ew.checkExpectations({ nowMs: HALT + s * 1000 });
    }
    return { cancels, pending: ew.placedLimitOrderIds() };
  } finally {
    globalThis.fetch = realFetch;
    ew.__resetExecWatchForTest();
  }
}

test("closed window: a successful cancel drops the card — one cancel, not one per tick", { timeout: 60_000 }, async () => {
  const r = await runHalt(true);
  assert.equal(r.cancels, 1);
  assert.deepEqual(r.pending, []);
});

test("closed window: a failing cancel keeps the card but retries at most once a minute", { timeout: 60_000 }, async () => {
  const r = await runHalt(false);
  assert.ok(r.cancels >= 100 && r.cancels <= 121, `cancels=${r.cancels}`);
  assert.deepEqual(r.pending, ["oid-1"]);
});
