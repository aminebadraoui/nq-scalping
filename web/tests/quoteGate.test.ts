import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteAgreeDecision } from "../lib/quoteGate";

test("quoteAgreeDecision: agrees inside the band, diverges beyond it, null is nodata", () => {
  // within the 3-pt band → ok (normal tape noise)
  assert.equal(quoteAgreeDecision(31141.5, 31141.0, 3), "ok");
  assert.equal(quoteAgreeDecision(31144.0, 31141.0, 3), "ok"); // exactly at the edge
  // the 2026-10-04 reopen: tape 31141 vs broker 31155 → refuse
  assert.equal(quoteAgreeDecision(31155.75, 31141.0, 3), "diverge");
  assert.equal(quoteAgreeDecision(31127.0, 31141.0, 3), "diverge"); // below too
  // unreadable quote (streaming client down) → policy decides, not the gate
  assert.equal(quoteAgreeDecision(null, 31141.0, 3), "nodata");
  assert.equal(quoteAgreeDecision(Number.NaN, 31141.0, 3), "nodata");
});
