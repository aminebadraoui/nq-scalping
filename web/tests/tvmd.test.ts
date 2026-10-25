/* Unit tests for lib/tvmd.ts token persistence — the frontend paste
 * path (POST /api/tvmd) writes the session token; the collector
 * watches the file and hot-restarts with it. Plus the pure autoheal
 * helpers (lib/tvmdRecap.ts) the VPS recapture loop is built on. */

import { test } from "node:test";
import assert from "node:assert";
import { rmSync, writeFileSync } from "node:fs";

// point the token file at a throwaway path BEFORE first use
const TMP = `/tmp/tvmd-token-test-${process.pid}.json`;
process.env.TVMD_TOKEN_FILE = TMP;
rmSync(TMP, { force: true });

const { persistToken, tokenInfo, nearestTickIn } = await import("../lib/tvmd");
const { anchoredAtOf, nextBackoffSeconds, shouldReanchor } = await import("../lib/tvmdRecap");

test("persistToken accepts a JWT-shaped token and rejects garbage", () => {
  const jwt =
    "eyJraWQiOiI1NyIsImFsZyI6IkVkRFNBIn0.eyJzdWIiOiIyMzIzOTYwIiwiZXhwIjoxNzkyNDUyNTM1LCJqdGkiOiI0ODE1OTYxNjk0NzkwNjU3NDUxLTE4NjI0Njg5NDcyNzE3MDM1MTMiLCJwaHMiOjEzMDM5ODQ2NTEsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.xD9hCVhOJAGo7Av8M7rRxwR_lWNwK5__6_veqpVLixOoasHZwn-DMCqCrJE6q1X-vq-PGCU9x8ixHeaIdYg1DA";
  assert.equal(persistToken(jwt), true);
  assert.equal(persistToken("not-a-token"), false);
  assert.equal(persistToken(""), false);
  assert.equal(persistToken("eyJh.eyJvbmx5dHdv"), false); // too short
});

test("tokenInfo returns masked prefix + renewedAt, never the token", () => {
  const info = tokenInfo();
  assert.ok(info);
  assert.equal(info!.prefix, "eyJraWQi…");
  assert.ok(!info!.prefix.includes(".")); // no payload leakage
  assert.ok(info!.renewedAt);
  assert.ok(!JSON.stringify(info).includes("2323960")); // sub stays masked
});

test("tokenInfo surfaces anchoredAt and the autoheal recap status", () => {
  const recapFile = `/tmp/tvmd-recap-test-${process.pid}.json`;
  process.env.TVMD_RECAP_STATUS = recapFile;
  rmSync(recapFile, { force: true });
  writeFileSync(
    TMP,
    JSON.stringify({ token: "eyJh.eyJh.eyJh", renewedAt: "2026-10-20T00:00:00Z", anchoredAt: "2026-10-20T01:00:00Z" }),
  );
  // no status file yet → recap null (the loop hasn't run)
  let info = tokenInfo();
  assert.equal(info!.anchoredAt, "2026-10-20T01:00:00Z");
  assert.equal(info!.recap, null);

  writeFileSync(recapFile, JSON.stringify({ googleSessionOk: false, failures: 2, lastHealAt: "2026-10-20T00:30:00Z", lastAttemptAt: "2026-10-20T02:00:00Z", lastAlertAt: null, lastError: "expired" }));
  info = tokenInfo();
  assert.equal(info!.recap?.googleSessionOk, false);
  assert.equal(info!.recap?.failures, 2);
  assert.equal(info!.recap?.lastError, "expired");
});

test("shouldReanchor: unanchored/garbage/stale re-anchor; fresh skips", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(shouldReanchor(null, now, 12), true, "never anchored → re-anchor");
  assert.equal(shouldReanchor("garbage", now, 12), true);
  assert.equal(shouldReanchor("2026-10-20T11:00:00Z", now, 12), false, "1h old, 12h window → skip");
  assert.equal(shouldReanchor("2026-10-19T23:59:59Z", now, 12), true, "≥12h old → re-anchor");
  assert.equal(shouldReanchor("2026-10-20T11:30:00Z", now, 0.5), true, "30min anchor, 0.5h window → re-anchor");
});

test("nextBackoffSeconds: failure ladder caps at 30 min", () => {
  assert.equal(nextBackoffSeconds(0), 0);
  assert.equal(nextBackoffSeconds(1), 300);
  assert.equal(nextBackoffSeconds(2), 900);
  assert.equal(nextBackoffSeconds(3), 1800);
  assert.equal(nextBackoffSeconds(99), 1800);
});

test("anchoredAtOf reads the anchor stamp and tolerates junk", () => {
  const f = `/tmp/tvmd-anchor-test-${process.pid}.json`;
  rmSync(f, { force: true });
  assert.equal(anchoredAtOf(f), null, "absent file → null");
  writeFileSync(f, JSON.stringify({ token: "x", anchoredAt: "2026-10-20T03:00:00Z" }));
  assert.equal(anchoredAtOf(f), "2026-10-20T03:00:00Z");
  writeFileSync(f, "{not json");
  assert.equal(anchoredAtOf(f), null);
  rmSync(f, { force: true });
});

test("nearestTickIn finds the closest tick and refuses far lookups", () => {
  const ticks = [
    { t: 1_000, price: 10, size: 1, bid: null, ask: null, bs: null, as: null, id: 1 },
    { t: 2_000, price: 10.25, size: 1, bid: null, ask: null, bs: null, as: null, id: 2 },
    { t: 3_000, price: 10.5, size: 1, bid: null, ask: null, bs: null, as: null, id: 3 },
  ];
  assert.equal(nearestTickIn(ticks, 2_100)?.id, 2); // closer to 2000 than 3000
  assert.equal(nearestTickIn(ticks, 2_900)?.id, 3);
  assert.equal(nearestTickIn(ticks, 500)?.id, 1);
  assert.equal(nearestTickIn(ticks, 100_000), null); // >60s away → refused
  assert.equal(nearestTickIn([], 1_000), null);
});
