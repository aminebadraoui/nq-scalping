/* Optional end-to-end check: when the dashboard's dev server is running, the
 * HTTP layer must return the same numbers as the modules it wraps. Skips
 * silently when the server is not up (CI without a server stays green). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DATE } from "./helpers.mjs";
import { analyze, computeSheet } from "../lib/gcdata.ts";

const BASE = process.env.DASH_URL ?? "http://localhost:3000";
async function alive() {
  try {
    const r = await fetch(`${BASE}/api/gc?action=datasets`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}
const up = await alive();

test("GET /api/gc analysis matches the module output", { skip: !up && `no server on ${BASE}` }, async () => {
  const j = await (await fetch(`${BASE}/api/gc?action=analysis&date=${DATE}&session=RTH&start=&end=&row=2`)).json();
  const a = await analyze(DATE, "RTH", undefined, undefined, 2);
  assert.equal(j.vwap, a.vwap);
  assert.equal(j.alerts.length, a.alerts.length);
  assert.equal(j.absorption.length, a.absorption.length);
  assert.equal(j.reclaims.length, a.reclaims.length);
  assert.deepEqual(j.imbalance.stacks.length, a.imbalance.stacks.length);
});

test("GET /api/gc sheet matches the module output", { skip: !up && `no server on ${BASE}` }, async () => {
  const j = await (await fetch(`${BASE}/api/gc?action=sheet&date=${DATE}`)).json();
  const s = await computeSheet(DATE);
  for (const k of Object.keys(s.profiles)) {
    assert.deepEqual(j.sheet.profiles[k] ?? null, s.profiles[k] ?? null, k);
  }
});

test("GET /api/gc supports all three session windows", { skip: !up && `no server on ${BASE}` }, async () => {
  const get = async (q) => (await fetch(`${BASE}/api/gc?action=footprint&date=${DATE}&${q}`)).json();
  assert.equal((await get("session=RTH&start=&end=")).minutes.length, 390);
  assert.equal((await get("session=ETH&start=08:30&end=15:59")).minutes.length, 450);
  assert.equal((await get("session=ETH&start=&end=")).minutes.length, 1380);
});
