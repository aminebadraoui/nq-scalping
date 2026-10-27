/* Regression (2026-10-26 audit): a naked-position episode that ends FLAT
 * must not carry its timer into the next trade. The old code only reset
 * the naked state when a working stop was found, so the next trade's
 * first protection check — run at the fill, inside the sub-second OSO
 * activation window — saw a stale timer and flattened a healthy entry.
 * Own file: it mocks fetch + Date.now for the whole process. */
import { test } from "node:test";
import assert from "node:assert/strict";

// the watcher only runs fully configured; Telegram goes to the mocked fetch
Object.assign(process.env, {
  EXECUTE_LIVE: "1", CROSSTRADE_KEY: "k", CROSSTRADE_ACCOUNT: "A",
  TELEGRAM_BOT_TOKEN: "1:test", TELEGRAM_CHAT_ID: "1", DAYBOOK_OFF: "1",
});
delete process.env.DATABASE_URL;

test("naked state resets on a confirmed flat — the next trade is not repaired at its fill", { timeout: 15_000 }, async () => {
  const ct = await import("../lib/ctAccount");
  const cx = await import("../lib/crossTrade");
  const ew = await import("../lib/execWatch");
  let pos: Array<Record<string, unknown>> = [];
  const posts: string[] = [];
  let clock = Date.parse("2026-10-27T14:00:00Z");
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  Date.now = () => clock;
  globalThis.fetch = (async (u: unknown, init?: { method?: string }) => {
    const url = String(u);
    if (init?.method === "POST") posts.push(url.replace(/.*accounts\/A/, ""));
    const data = url.endsWith("/positions") ? pos : [];
    const body = { success: true, data };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
  }) as typeof fetch;
  const poll = async () => {
    ct.__resetCtAccountForTest({ backoffBaseMs: 1 });
    await ew.checkProtection();
    await new Promise((r) => setTimeout(r, 30));
  };
  const intent = (dir: "long" | "short") => ({
    symbol: "NQ", dir, contracts: 2, entry: 20000,
    stop: dir === "long" ? 19990 : 20010, target: dir === "long" ? 20020 : 19980, timeET: "10:00",
  });
  try {
    ew.__resetExecWatchForTest();
    // trade A: open with no working stop (naked), then goes flat before repair
    cx.setOpenProtection({ intent: intent("long"), rearmOk: true, at: clock } as never);
    pos = [{ id: "p", instrument: "MNQZ6", netPos: 2 }];
    await poll();
    pos = [];
    clock += 5_000;
    await poll();
    clock += 21_000;
    await poll(); // flat claim confirmed
    assert.equal(cx.openProtection(), null);
    // trade B, 40 min later: first check lands before its OSO stop is live
    clock += 40 * 60_000;
    posts.length = 0;
    cx.setOpenProtection({ intent: intent("short"), rearmOk: true, at: clock } as never);
    pos = [{ id: "p", instrument: "MNQZ6", netPos: -2 }];
    await poll();
    assert.deepEqual(
      posts.filter((p) => p.includes("flatten") || p.includes("/orders")),
      [],
      "first check of a fresh trade must alert and wait, not repair",
    );
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    ew.__resetExecWatchForTest();
  }
});
