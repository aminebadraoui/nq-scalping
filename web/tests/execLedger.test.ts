/* Unit tests for lib/execLedger.ts — the joined signal → execution merge. */

import { test } from "node:test";
import assert from "node:assert";
import { familyFromVerdict, execMatchesSignalFallback, mergeExecLedger, parseExitFills, type LedgerExec, type LedgerSignal } from "../lib/execLedger";

const sig = (p: Partial<LedgerSignal>): LedgerSignal => ({
  key: "mv-1",
  ts: 1000,
  day: "2026-10-16",
  time_et: "06:24",
  side: "short",
  verdict: "momentum (failed-flush breakout · limit)",
  headline: "NQ momentum short",
  sent: true,
  reason: "sent",
  outcome: "",
  entry: 30113.13,
  stop: 30118.5,
  target: 30107.75,
  ...p,
});

const exec = (p: Partial<LedgerExec>): LedgerExec => ({
  key: "mom|2026-10-16|short|05:24",
  signal_id: "",
  ts: 2000,
  day: "2026-10-16",
  time_et: "06:24",
  label: "momentum short 06:24 (flush limit)",
  family: "momentum",
  side: "short",
  contracts: 8,
  sig_entry: 30113.13,
  sig_stop: 30118.5,
  sig_target: 30107.75,
  order_id: "ord-1",
  status: "closed",
  fill_entry: 30113.5,
  fill_entry_at: 1500,
  exit_avg: 30107.75,
  exit_fills: [{ ts: 2000, action: "Buy", qty: 8, price: 30107.75 }],
  pts: 46,
  gross_usd: 92,
  fees_usd: 15.2,
  net_usd: 76.8,
  result: "win",
  ...p,
});

test("familyFromVerdict maps the verdict vocabulary", () => {
  assert.equal(familyFromVerdict("rth soft-continuation (experimental)"), "session_continuation");
  assert.equal(familyFromVerdict("momentum (failed-flush breakout)"), "momentum");
  assert.equal(familyFromVerdict("failed-flush breakout"), "momentum");
  assert.equal(familyFromVerdict("session continuation (experimental)"), "session_continuation");
  assert.equal(familyFromVerdict("momentum (big-bar continuation · limit)"), "momentum");
  assert.equal(familyFromVerdict("open drive (experimental)"), "open_drive");
  assert.equal(familyFromVerdict("sweep-reclaim (one-sided)"), "sweep_reclaim");
  assert.equal(familyFromVerdict("unknown"), "");
});

test("execMatchesSignalFallback joins by day/time/side/family when signal_id is empty", () => {
  assert.equal(execMatchesSignalFallback(exec({}), sig({})), true);
  assert.equal(execMatchesSignalFallback(exec({ day: "2026-10-15" }), sig({})), false);
  assert.equal(execMatchesSignalFallback(exec({ side: "long" }), sig({})), false);
  // primary key match wins regardless of fallback fields
  assert.equal(execMatchesSignalFallback(exec({ signal_id: "mv-1", day: "2099-01-01" }), sig({})), true);
});

test("mergeExecLedger joins signal+exec into one row", () => {
  const { rows, summary } = mergeExecLedger([sig({})], [exec({})], []);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.linked, "both");
  assert.equal(r.sent, true);
  assert.equal(r.status, "closed");
  assert.equal(r.netUsd, 76.8);
  assert.equal(r.contracts, 8);
  assert.equal(r.headline, "NQ momentum short");
  assert.equal(summary.cards, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.netUsd, 76.8);
});

test("mergeExecLedger keeps gated signal-only rows (sent=false, no exec)", () => {
  const { rows, summary } = mergeExecLedger(
    [sig({ key: "mv-2", sent: false, reason: "daily card cap 3", time_et: "15:23" })],
    [],
    [],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].linked, "signal");
  assert.equal(rows[0].status, null);
  assert.equal(rows[0].sentReason, "daily card cap 3");
  assert.equal(summary.notSent, 1);
  assert.equal(summary.executed, 0);
});

test("mergeExecLedger keeps exec-only rows (pre-journaling limit cards)", () => {
  const { rows } = mergeExecLedger([], [exec({})], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].linked, "exec");
  assert.equal(rows[0].sent, null);
  assert.equal(rows[0].status, "closed");
});

test("mergeExecLedger attaches the exec-log reason to failed rows", () => {
  const { rows } = mergeExecLedger(
    [sig({})],
    [exec({ status: "failed", net_usd: 0, result: "" })],
    [{ key: "mom|2026-10-16|short|05:24", outcome: "failed", reason: "crossed-limit gate — tape through limit" }],
  );
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].execReason, "crossed-limit gate — tape through limit");
});

test("mergeExecLedger sorts newest first and prefers closed rows' money math", () => {
  const a = exec({ ts: 100 });
  const b = exec({ ts: 900, key: "mom|2026-10-16|short|06:00", signal_id: "", day: "2026-10-16", time_et: "07:00" });
  const { rows } = mergeExecLedger([], [a, b], []);
  assert.equal(rows[0].ts, 900);
  assert.equal(rows[1].ts, 100);
});

test("parseExitFills: jsonb string, array, null and junk all become an array", () => {
  const fill = { ts: 1, action: "Buy", qty: 2, price: 29100.25 };
  assert.deepStrictEqual(parseExitFills(JSON.stringify([fill])), [fill]);
  assert.deepStrictEqual(parseExitFills([fill]), [fill]);
  assert.deepStrictEqual(parseExitFills("[]"), []);
  assert.deepStrictEqual(parseExitFills(null), []);
  assert.deepStrictEqual(parseExitFills(undefined), []);
  assert.deepStrictEqual(parseExitFills("not json"), []);
  assert.deepStrictEqual(parseExitFills('{"a":1}'), []);
});

test("mergeExecLedger: a JSON-string exit_fills (execTracker's jsonb write) reaches the row as an array", () => {
  const fill = { ts: 1792781042783, action: "Buy", qty: 6, price: 29167.75 };
  const { rows } = mergeExecLedger([], [exec({ exit_fills: JSON.stringify([fill]) })], []);
  assert.ok(Array.isArray(rows[0].exitFills));
  assert.deepStrictEqual(rows[0].exitFills, [fill]);
});
