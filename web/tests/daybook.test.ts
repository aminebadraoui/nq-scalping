/* Unit tests for the daybook (lib/daybook.ts) — the DB-less system
 * journal: settings snapshot + variation fingerprint, trading-day key,
 * and the append/read round-trip on an isolated temp dir. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  maskSetting,
  settingsSnapshot,
  variationFingerprint,
  daybookDayKey,
  daybookFile,
  appendDaybook,
  bootDaybook,
  readDaybookDay,
  listDaybookDays,
} from "../lib/daybook";

function tmpEnv(): Record<string, string | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), "daybook-test-"));
  return { GC_DATA_DIR: dir };
}

test("maskSetting hashes secrets and keeps knobs verbatim", () => {
  assert.equal(maskSetting("RTH_STOP_MULT", "0.45"), "0.45");
  assert.equal(maskSetting("MFF_STAGE", undefined), "");
  const a = maskSetting("CROSSTRADE_KEY", "super-secret");
  const b = maskSetting("CROSSTRADE_KEY", "super-secret");
  const c = maskSetting("CROSSTRADE_KEY", "different");
  assert.match(a, /^sha256:[0-9a-f]{10}$/);
  assert.equal(a, b); // stable
  assert.notEqual(a, c); // a changed secret changes the fingerprint
  assert.match(maskSetting("DATABASE_URL", "postgres://u:p@h/db"), /^sha256:/);
});

test("settingsSnapshot contains every canonical key with no raw secrets", () => {
  const s = settingsSnapshot({ CROSSTRADE_KEY: "k", RTH_STOP_MULT: "0.45" });
  assert.equal(s.RTH_STOP_MULT, "0.45");
  assert.match(s.CROSSTRADE_KEY, /^sha256:/);
  assert.ok(Object.keys(s).includes("FEED_RTH"));
  assert.ok(Object.keys(s).includes("DAILY_LOSS_FLOOR"));
  assert.ok(Object.keys(s).includes("PROFIT_ARM"));
  assert.ok(Object.keys(s).includes("RTH_MAX_CARDS_PER_DAY"));
});

test("variationFingerprint: same config = same id; any knob change = new id", () => {
  const a = settingsSnapshot({ RTH_STOP_MULT: "0.45", FEED_RTH: "1" });
  const b = settingsSnapshot({ RTH_STOP_MULT: "0.45", FEED_RTH: "1" });
  const c = settingsSnapshot({ RTH_STOP_MULT: "0.65", FEED_RTH: "1" });
  assert.equal(variationFingerprint("abc", a), variationFingerprint("abc", b));
  assert.notEqual(variationFingerprint("abc", a), variationFingerprint("abc", c));
  assert.notEqual(variationFingerprint("abc", a), variationFingerprint("def", a));
});

test("daybookDayKey: 22:00 ET belongs to the session that opened that evening", () => {
  // 2026-10-07T02:00:00Z = 22:00 ET Oct 6 -> day key 2026-10-06
  assert.equal(daybookDayKey(new Date("2026-10-07T02:00:00Z")), "2026-10-06");
  // 2026-10-07T20:00:00Z = 16:00 ET Oct 7 -> still the Oct 6 session
  assert.equal(daybookDayKey(new Date("2026-10-07T20:00:00Z")), "2026-10-06");
  // 2026-10-07T22:00:00Z = 18:00 ET Oct 7 -> new session keyed Oct 7
  assert.equal(daybookDayKey(new Date("2026-10-07T22:00:00Z")), "2026-10-07");
});

test("append + read round-trip keeps record order and shape", () => {
  const env = tmpEnv();
  try {
    const day = "2026-10-06";
    appendDaybook({ t: "boot", at: 1, sha: "abc", buildId: "x", variationId: "v1", settings: {} }, day, env);
    appendDaybook(
      {
        t: "exec",
        at: 2,
        key: "k1",
        label: "rth",
        attempt: "initial",
        outcome: "ok",
        reason: "",
      },
      day,
      env,
    );
    const rows = readDaybookDay(day, env);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].t, "boot");
    assert.equal(rows[1].t, "exec");
    assert.deepEqual(rows[1], {
      t: "exec",
      at: 2,
      key: "k1",
      label: "rth",
      attempt: "initial",
      outcome: "ok",
      reason: "",
    });
    const raw = readFileSync(daybookFile(day, env), "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  } finally {
    rmSync(env.GC_DATA_DIR as string, { recursive: true, force: true });
  }
});

test("bootDaybook writes once per process and never leaks secrets", () => {
  const env = tmpEnv();
  try {
    bootDaybook({ ...env, BUILD_SHA: "deadbeef", CROSSTRADE_KEY: "topsecret" });
    bootDaybook({ ...env, BUILD_SHA: "deadbeef", CROSSTRADE_KEY: "topsecret" });
    const rows = readDaybookDay(daybookDayKey(), env);
    const boots = rows.filter((r) => r.t === "boot");
    assert.equal(boots.length, 1);
    const boot = boots[0] as Extract<(typeof rows)[number], { t: "boot" }>;
    assert.equal(boot.sha, "deadbeef");
    assert.match(boot.settings.CROSSTRADE_KEY, /^sha256:/);
    assert.match(boot.variationId, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(boot).includes("topsecret"));
  } finally {
    rmSync(env.GC_DATA_DIR as string, { recursive: true, force: true });
  }
});

test("listDaybookDays lists only day files, newest first is not required", () => {
  const env = tmpEnv();
  try {
    appendDaybook({ t: "boot", at: 1, sha: "", buildId: "", variationId: "x", settings: {} }, "2026-10-05", env);
    appendDaybook({ t: "boot", at: 2, sha: "", buildId: "", variationId: "x", settings: {} }, "2026-10-06", env);
    const days = listDaybookDays(env);
    assert.deepEqual(days, ["2026-10-05", "2026-10-06"]);
  } finally {
    rmSync(env.GC_DATA_DIR as string, { recursive: true, force: true });
  }
});
