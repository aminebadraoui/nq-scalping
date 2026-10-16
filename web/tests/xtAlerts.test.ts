/* Unit tests for lib/xtAlerts.ts — the CrossTrade pushed-alert parsing
 * and the HMAC signature check. */

import { test } from "node:test";
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { parsePositionClosed, parsePositionOpened, verifyXtSignature, xtAlertKind } from "../lib/xtAlerts";

test("parsePositionClosed: the vendor's alert message shape", () => {
  assert.deepEqual(parsePositionClosed("Closed Short -8 MNQZ6 @ 30107.75. P&L: +$92.00."), {
    side: "short",
    qty: 8,
    instrument: "MNQZ6",
    exitPrice: 30107.75,
    pnlUsd: 92,
  });
  assert.deepEqual(parsePositionClosed("Closed Short -5 MNQZ6 @ 30153.75. P&L: -$87.50."), {
    side: "short",
    qty: 5,
    instrument: "MNQZ6",
    exitPrice: 30153.75,
    pnlUsd: -87.5,
  });
  assert.deepEqual(parsePositionClosed("Closed Long -25 MNQZ6 @ 30544.25. P&L: +$475.00."), {
    side: "long",
    qty: 25,
    instrument: "MNQZ6",
    exitPrice: 30544.25,
    pnlUsd: 475,
  });
  assert.equal(parsePositionClosed("Position Closed - DEMO2323960"), null);
});

test("parsePositionOpened: the vendor's alert message shape", () => {
  assert.deepEqual(parsePositionOpened("Opened Short +8 MNQZ6 @ 30113.5."), {
    side: "short",
    qty: 8,
    instrument: "MNQZ6",
    entryPrice: 30113.5,
  });
  assert.equal(parsePositionOpened("Position Opened - DEMO2323960"), null);
});

test("verifyXtSignature: HMAC-SHA256 over the raw body, constant-time", () => {
  const secret = "test-secret-123";
  const body = '{"type":"position_closed","title":"x"}';
  const sig = "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
  assert.equal(verifyXtSignature(body, sig, secret), true);
  assert.equal(verifyXtSignature(body, sig.toUpperCase(), secret), true);
  assert.equal(verifyXtSignature(body, sig, "wrong-secret"), false);
  assert.equal(verifyXtSignature(body, null, secret), false);
  assert.equal(verifyXtSignature(body, sig, null), false);
  assert.equal(verifyXtSignature(body, "sha256=" + "0".repeat(64), secret), false);
});

test("xtAlertKind: tolerant type/title/message routing", () => {
  assert.equal(xtAlertKind({ type: "position_closed", title: "Position Closed - DEMO2323960", message: "" }), "closed");
  assert.equal(xtAlertKind({ title: "Position Opened - DEMO2323960", message: "" }), "opened");
  assert.equal(xtAlertKind({ type: "auto_flatten", title: "Auto-Flatten Fired - Sim101", message: "" }), "protection");
  assert.equal(xtAlertKind({ message: "Position Protection Alert - DEMO2323960" }), "protection");
  assert.equal(xtAlertKind({ type: "payment_failed" }), "other");
});
