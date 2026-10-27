/* Regression (2026-10-26 audit): two placements started in the same tick
 * both passed the flat pre-flight (the stacking latch is only set after
 * the POST) and both POSTed — a stacked position. Placements are now
 * serialized; the second sees the latch and is refused. Own file: it
 * mocks fetch for the whole process. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

Object.assign(process.env, {
  GC_DATA_DIR: mkdtempSync(path.join(tmpdir(), "placelock-")),
  CROSSTRADE_URL: "https://x.invalid/hook", CROSSTRADE_KEY: "k", CROSSTRADE_ACCOUNT: "ACC1",
  EXECUTE_LIVE: "1", MFF_STAGE: "eval", DAYBOOK_OFF: "1", TELEGRAM_BOT_TOKEN: "",
});
delete process.env.DATABASE_URL;

test("concurrent placements: exactly one order POST, the other refused by the stacking latch", { timeout: 30_000 }, async () => {
  let places = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    await new Promise((r) => setTimeout(r, 50)); // a real round trip
    const mk = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.endsWith("/accounts/snapshot")) return mk({ accounts: [{ name: "ACC1", netLiq: 50000, realizedPnl: 0 }] });
    if (u.endsWith("/positions")) return mk({ success: true, data: [] });
    if (u.endsWith("/orders/place")) {
      places++;
      return mk({ success: true, response: {} });
    }
    return mk({ success: true, data: [] });
  }) as typeof fetch;
  try {
    const ct = await import("../lib/crossTrade");
    const acct = await import("../lib/ctAccount");
    acct.__resetCtAccountForTest?.({ gapMs: 0 } as never);
    const intent = { symbol: "NQZ26", dir: "long" as const, contracts: 5, entry: 25000, stop: 24990, target: 25010, timeET: "10:00" };
    const [a, b] = await Promise.all([ct.placeCrossTradeOrderREST(intent), ct.placeCrossTradeOrderREST({ ...intent })]);
    assert.equal(places, 1, "only one order may reach the broker");
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
    assert.match((a.ok ? b : a).reason, /refusing to stack/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("lock: a market entry queued > PLACEMENT_MAX_QUEUE_MS behind a slow placement is refused as stale", { timeout: 30_000 }, async () => {
  const ct = await import("../lib/crossTrade");
  const acct = await import("../lib/ctAccount");
  ct.__resetLatchForTest();
  let places = 0;
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const mk = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (u.endsWith("/accounts/snapshot")) return mk({ accounts: [{ name: "ACC1", netLiq: 50000, realizedPnl: 0 }] });
    if (u.endsWith("/positions")) return mk({ success: true, data: [] });
    if (u.endsWith("/orders/place")) {
      places++;
      skew += ct.PLACEMENT_MAX_QUEUE_MS + 5_000; // the broker took 25s
      return mk({ success: false, error: "rejected for the test" }); // a REJECT: no latch
    }
    return mk({ success: true, data: [] });
  }) as typeof fetch;
  try {
    acct.__resetCtAccountForTest?.({ gapMs: 0 } as never);
    const intent = { symbol: "NQZ26", dir: "long" as const, contracts: 5, entry: 25000, stop: 24990, target: 25010, timeET: "10:00" };
    const [a, b] = await Promise.all([ct.placeCrossTradeOrderREST(intent), ct.placeCrossTradeOrderREST({ ...intent })]);
    assert.equal(places, 1, "the queued market entry must not be sent late");
    assert.equal(a.ok, false);
    assert.match(b.reason, /refused as stale/);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    ct.__resetLatchForTest();
  }
});

test("lock: an UNKNOWN placement (5xx) arms the stacking latch — the next entry cannot stack on it", { timeout: 30_000 }, async () => {
  const ct = await import("../lib/crossTrade");
  const acct = await import("../lib/ctAccount");
  ct.__resetLatchForTest();
  let places = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const mk = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (u.endsWith("/accounts/snapshot")) return mk({ accounts: [{ name: "ACC1", netLiq: 50000, realizedPnl: 0 }] });
    if (u.endsWith("/positions")) return mk({ success: true, data: [] });
    if (u.endsWith("/orders/place")) {
      places++;
      return mk({ error: "bad gateway" }, 502);
    }
    return mk({ success: true, data: [] });
  }) as typeof fetch;
  try {
    acct.__resetCtAccountForTest?.({ gapMs: 0 } as never);
    const intent = { symbol: "NQZ26", dir: "short" as const, contracts: 3, entry: 25000, stop: 25010, target: 24990, timeET: "10:05" };
    const a = await ct.placeCrossTradeOrderREST(intent);
    const b = await ct.placeCrossTradeOrderREST({ ...intent });
    assert.equal(places, 1);
    assert.equal(a.ok, false);
    assert.match(b.reason, /refusing to stack/);
  } finally {
    globalThis.fetch = realFetch;
    ct.__resetLatchForTest();
  }
});
