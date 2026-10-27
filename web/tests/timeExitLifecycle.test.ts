/* Regression (2026-10-26 audit): a pending time exit outlived its trade
 * and fired at its deadline against a LATER position (sending e.g. a buy
 * that doubled a new long). Own file: mocks fetch + Date.now. */
import { test } from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  EXECUTE_LIVE: "1", CROSSTRADE_KEY: "k", CROSSTRADE_ACCOUNT: "A",
  TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_CHAT_ID: "1", DAYBOOK_OFF: "1",
});
delete process.env.DATABASE_URL;

test("time exit: dropped once its trade is seen open then flat; fires on a matching short", { timeout: 20_000 }, async () => {
  const te = await import("../lib/timeExit");
  const ct = await import("../lib/ctAccount");
  let pos: Array<Record<string, unknown>> = [];
  const posts: string[] = [];
  let clock = Date.parse("2026-10-27T15:00:00Z");
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  Date.now = () => clock;
  globalThis.fetch = (async (u: unknown, init?: { method?: string; body?: string }) => {
    const url = String(u);
    if (init?.method === "POST" && !url.includes("telegram")) posts.push(`${url.replace(/.*accounts\/A/, "")} ${init.body ?? ""}`);
    const body = { success: true, data: url.endsWith("/positions") ? pos : [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
  }) as typeof fetch;
  const tick = async () => {
    ct.__resetCtAccountForTest({ backoffBaseMs: 1 } as never);
    await te.checkTimeExits();
  };
  try {
    te.__resetTimeExitForTest();
    // short A registered with a 60-min exit; it is open, then stopped out
    te.registerTimeExit({ key: "a", label: "A short", symbol: "NQZ26", dir: "short", exitAtMs: clock + 60 * 60_000 });
    pos = [{ instrument: "MNQZ6", netPos: -3 }];
    await tick();
    clock += 10 * 60_000;
    pos = [];
    await tick(); // seen open, now flat → dropped
    // a later LONG opens; at A's old deadline nothing may be sent
    clock += 20 * 60_000;
    pos = [{ instrument: "MNQZ6", netPos: 3 }];
    await tick();
    clock += 31 * 60_000;
    await tick();
    assert.deepEqual(posts, [], "A's exit must not touch the later long");
    // a short that is still open at its deadline DOES time-exit
    te.registerTimeExit({ key: "b", label: "B short", symbol: "NQZ26", dir: "short", exitAtMs: clock + 60_000 });
    pos = [{ instrument: "MNQZ6", netPos: -2 }];
    await tick();
    clock += 2 * 60_000;
    await tick();
    assert.equal(posts.length, 1, `expected one exit, got ${JSON.stringify(posts)}`);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    te.__resetTimeExitForTest();
  }
});
