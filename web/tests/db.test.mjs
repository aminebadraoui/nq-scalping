/* Neon read-through parity: with DATABASE_URL set, the DB path must produce
 * the SAME numbers as the local files for the audited session. Skips when no
 * database is configured (CI without credentials stays green). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dbEnabled } from "../lib/gcdb.ts";
import * as gc from "../lib/gcdata.ts";
import { DATE } from "./helpers.mjs";

const up = dbEnabled();

const snapshot = (a) => {
  const counts = {};
  for (const x of a.alerts) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  return {
    vwap: +a.vwap.toFixed(6),
    counts,
    absorption: a.absorption.map((x) => `${x.t}|${x.price}|${x.side}|${x.volume}|${x.imbalance.toFixed(4)}`),
    reclaims: a.reclaims.length,
    stacks: a.imbalance.stacks.length,
    poc: a.stats.poc,
    vah: a.stats.vah,
    val: a.stats.val,
    rows: a.rows.length,
  };
};

async function fileAnalysis() {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return snapshot(await gc.analyze(DATE, "RTH", undefined, undefined, 2));
  } finally {
    if (prev) process.env.DATABASE_URL = prev;
  }
}

test("datasets come from the DB (and the audited session is latest)", { skip: !up && "no DATABASE_URL" }, async () => {
  const ds = await gc.listDatasets();
  assert.ok(ds.length >= 5);
  assert.equal(ds[0].date, DATE, "latest dataset is the audited one");
  assert.equal(ds[0].candles.RTH, 390);
  assert.equal(ds[0].candles.ETH, 1380);
});

test("footprint minutes from the DB match the file shape", { skip: !up && "no DATABASE_URL" }, async () => {
  const fp = await gc.extractFootprint(DATE, "RTH");
  assert.equal(fp.minutes.length, 390);
  assert.equal(fp.minutes[0].t, "08:30");
  assert.equal(fp.minutes.at(-1).t, "14:59");
  assert.equal(fp.ohlcBars, 390);
  const m = fp.minutes[60]; // 09:30 — the minute we diffed against the file
  assert.equal(m.levels.length, 105);
  assert.equal(typeof m.levels[0].buy, "number", "bigint must arrive as numbers, not strings");
  assert.equal(m.levels.reduce((s, l) => s + l.buy, 0), m.buy, "level buy sums to the bar buy");
});

test("analysis from the DB equals the file-based analysis exactly", { skip: !up && "no DATABASE_URL" }, async () => {
  const fromDb = snapshot(await gc.analyze(DATE, "RTH", undefined, undefined, 2));
  const fromFile = await fileAnalysis();
  assert.deepEqual(fromDb, fromFile, "every alert, absorption event and rollup must match");
});

test("the level sheet from the DB matches the file computation", { skip: !up && "no DATABASE_URL" }, async () => {
  const viaDb = await gc.computeSheet(DATE);
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const viaFile = await gc.computeSheet(DATE);
  if (prev) process.env.DATABASE_URL = prev;
  for (const k of Object.keys(viaFile.profiles)) {
    assert.deepEqual(viaDb.profiles[k] ?? null, viaFile.profiles[k] ?? null, k);
  }
});
