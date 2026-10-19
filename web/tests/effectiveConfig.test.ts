/* Effective-config resolver tests — pin the feed-flag semantics and the
 * snapshot assembly (architecture review P2). */

import { test } from "node:test";
import assert from "node:assert";
import { effectiveConfigSnapshot, resolveFeedFlag } from "../lib/effectiveConfig";
import { STRATEGIES } from "../lib/strategies/registry";

test("resolveFeedFlag mirrors the live feed semantics", () => {
  const env = (v: string | undefined): Record<string, string | undefined> => ({ X: v });
  assert.equal(resolveFeedFlag("X", true, env(undefined)), true, "unset → default");
  assert.equal(resolveFeedFlag("X", true, env("")), true, "empty → default");
  assert.equal(resolveFeedFlag("X", true, env("1")), true);
  assert.equal(resolveFeedFlag("X", true, env("true")), true);
  assert.equal(resolveFeedFlag("X", true, env("yes")), true);
  assert.equal(resolveFeedFlag("X", true, env("on")), true);
  assert.equal(resolveFeedFlag("X", true, env("0")), false);
  assert.equal(resolveFeedFlag("X", true, env("false")), false);
  assert.equal(resolveFeedFlag("X", true, env("no")), false);
  assert.equal(resolveFeedFlag("X", true, env("off")), false);
  assert.equal(resolveFeedFlag("X", false, env(undefined)), false);
});

test("snapshot resolves every declared strategy's feed from env + default", () => {
  const env = { FEED_MOMENTUM: "1", FEED_RTH: "0", FEED_OPEN: "1", FEED_OPEN_DRIVE: "1" };
  const cfg = effectiveConfigSnapshot(env);
  const byId = new Map(cfg.strategies.map((s) => [s.id, s]));
  assert.equal(byId.get("failed_flush_breakout")!.feedEnabled, true);
  assert.equal(byId.get("huge_bar_expansion")!.feedEnabled, true);
  assert.equal(byId.get("session_continuation")!.feedEnabled, false, "env 0 wins over default true");
  assert.equal(byId.get("open_drive")!.feedEnabled, true);
  assert.equal(byId.get("open_pullback")!.feedEnabled, false);
  assert.equal(byId.get("sweep_reclaim")!.feedEnabled, false);
});

test("snapshot carries the guard config and the override rows", () => {
  const cfg = effectiveConfigSnapshot({ DAILY_LOSS_FLOOR: "500" }, [{ id: 1, family: "rth", gate: "hour_veto", value: { hours: [14] } }], ["CROSSTRADE_ACCOUNT"]);
  assert.equal(cfg.guard.dailyFloor, 500);
  assert.equal(cfg.guard.profitArm, 400);
  assert.deepEqual(cfg.overrides, [{ family: "rth", gate: "hour_veto", value: { hours: [14] } }]);
  assert.deepEqual(cfg.operator, ["CROSSTRADE_ACCOUNT"]);
});

test("every registry strategy appears in the snapshot", () => {
  const cfg = effectiveConfigSnapshot({});
  assert.equal(cfg.strategies.length, STRATEGIES.length);
  const ids = new Set(cfg.strategies.map((s) => s.id));
  for (const s of STRATEGIES) assert.ok(ids.has(s.id), `missing ${s.id}`);
});

test("frozenAt is the caller-supplied timestamp", () => {
  const cfg = effectiveConfigSnapshot({}, [], [], 123456);
  assert.equal(cfg.frozenAt, 123456);
});
