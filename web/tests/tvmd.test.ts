/* Unit tests for lib/tvmd.ts token persistence — the frontend paste
 * path (POST /api/tvmd) writes the session token; the collector
 * watches the file and hot-restarts with it. */

import { test } from "node:test";
import assert from "node:assert";
import { rmSync } from "node:fs";

// point the token file at a throwaway path BEFORE first use
const TMP = `/tmp/tvmd-token-test-${process.pid}.json`;
process.env.TVMD_TOKEN_FILE = TMP;
rmSync(TMP, { force: true });

const { persistToken, tokenInfo, nearestTickIn } = await import("../lib/tvmd");

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
