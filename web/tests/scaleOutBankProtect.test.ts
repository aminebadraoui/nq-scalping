/* Regression (2026-10-26 audit): a scale-out whose RUNNER leg failed
 * returned before the already-placed BANK leg was registered with the
 * protection watchdog — an open, untracked position. Own file: mocks fetch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

Object.assign(process.env, {
  GC_DATA_DIR: mkdtempSync(path.join(tmpdir(), "scaleout-")),
  CROSSTRADE_URL: "https://x.invalid/hook", CROSSTRADE_KEY: "k", CROSSTRADE_ACCOUNT: "ACC1",
  EXECUTE_LIVE: "1", MFF_STAGE: "eval", DAYBOOK_OFF: "1", TELEGRAM_BOT_TOKEN: "",
});
delete process.env.DATABASE_URL;

test("scale-out: runner rejected → the open bank is registered for protection", { timeout: 30_000 }, async () => {
  let placeN = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const mk = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
    if (u.endsWith("/accounts/snapshot")) return mk({ accounts: [{ name: "ACC1", netLiq: 50000, realizedPnl: 0 }] });
    if (u.endsWith("/positions")) return mk({ success: true, data: [] });
    if (u.endsWith("/orders/place")) {
      placeN++;
      return placeN === 1 ? mk({ success: true, response: {} }) : mk({ success: false, error: "InvalidPrice" });
    }
    return mk({ success: true, data: [] });
  }) as typeof fetch;
  try {
    const ct = await import("../lib/crossTrade");
    const acct = await import("../lib/ctAccount");
    acct.__resetCtAccountForTest?.({ gapMs: 0 } as never);
    ct.setOpenProtection(null);
    const intent = { symbol: "NQZ26", dir: "long" as const, contracts: 9, entry: 25000, stop: 24990, target: 25010, timeET: "10:00" };
    const r = await ct.placeCrossTradeScaleOutREST(intent);
    assert.equal(placeN, 2);
    assert.equal(r.ok, false); // the pair failed — reported as before
    const reg = ct.openProtection();
    assert.ok(reg, "the open bank must be tracked by the protection watchdog");
    assert.equal(reg!.intent.contracts, ct.splitScaleOut(intent).bank.contracts);
    assert.equal(reg!.rearmOk, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
