/* Unit tests for the flatten arm (lib/flattenArm.ts): the pure day
 * target/loss flatten decision, the once-per-day latch, and the webhook
 * payload builders. The I/O (flattenViaWebhook / flattenArmFire) is
 * covered in crossTrade.test.ts's dry-run paths. */
import { test } from "node:test";
import assert from "node:assert";
import {
  flattenArmStep,
  flattenArmEnabled,
  buildFlattenWebhookPayload,
  buildCancelAllWebhookPayload,
  type FlattenArmConfig,
} from "../lib/flattenArm";

const OFF: FlattenArmConfig = { flattenAtProfit: 0, flattenAtLoss: 0 };
const ON: FlattenArmConfig = { flattenAtProfit: 400, flattenAtLoss: 250 };

test("off by default: neither side enabled never fires", () => {
  assert.equal(flattenArmEnabled(OFF), false);
  for (const livePnl of [500, -500, 0]) {
    const s = flattenArmStep(OFF, livePnl, 0, "", "2026-10-12");
    assert.equal(s.fire, "none");
  }
});

test("loss side: live P&L (realized + open) crossing −loss fires loss", () => {
  const s = flattenArmStep(ON, -180, -80, "", "2026-10-12");
  assert.equal(s.fire, "loss");
  assert.equal(s.livePnl, -260);
  assert.match(s.reason, /FLATTEN_AT_LOSS/);
});

test("profit side: live P&L crossing +profit fires profit", () => {
  const s = flattenArmStep(ON, 350, 60, "", "2026-10-12");
  assert.equal(s.fire, "profit");
  assert.equal(s.livePnl, 410);
});

test("undefined openPnl is treated as zero (realized-only)", () => {
  const s = flattenArmStep(ON, -260, undefined, "", "2026-10-12");
  assert.equal(s.fire, "loss");
  const s2 = flattenArmStep(ON, 410, undefined, "", "2026-10-12");
  assert.equal(s2.fire, "profit");
});

test("no fire inside the band", () => {
  assert.equal(flattenArmStep(ON, -100, -100, "", "2026-10-12").fire, "none");
  assert.equal(flattenArmStep(ON, 200, 150, "", "2026-10-12").fire, "none");
});

test("once-per-day latch: fires once, stays latched for the day, re-arms next day", () => {
  const day = "2026-10-12";
  const first = flattenArmStep(ON, -260, 0, "", day);
  assert.equal(first.fire, "loss");
  // the caller records the latch; a second evaluation the same day is silent
  const second = flattenArmStep(ON, -500, 0, day, day);
  assert.equal(second.fire, "none");
  assert.match(second.reason, /already fired/);
  // a flat account later the same day cannot re-trigger
  assert.equal(flattenArmStep(ON, 10, -10, day, day).fire, "none");
  // next trading day re-arms
  assert.equal(flattenArmStep(ON, -260, 0, day, "2026-10-13").fire, "loss");
});

test("profit and loss thresholds are independent (one side can be off)", () => {
  const lossOnly: FlattenArmConfig = { flattenAtProfit: 0, flattenAtLoss: 250 };
  assert.equal(flattenArmStep(lossOnly, 500, 0, "", "2026-10-12").fire, "none");
  assert.equal(flattenArmStep(lossOnly, -260, 0, "", "2026-10-12").fire, "loss");
  const profitOnly: FlattenArmConfig = { flattenAtProfit: 400, flattenAtLoss: 0 };
  assert.equal(flattenArmStep(profitOnly, 410, 0, "", "2026-10-12").fire, "profit");
  assert.equal(flattenArmStep(profitOnly, -900, 0, "", "2026-10-12").fire, "none");
});

test("flatten webhook payload: command/account/destination", () => {
  const p = buildFlattenWebhookPayload({ key: "k", account: "MFFUEVREOD…" });
  assert.deepEqual(p, { key: "k", command: "flatten", account: "MFFUEVREOD…", destination: "tradovate" });
});

test("cancel-all payload kills resting brackets first", () => {
  const p = buildCancelAllWebhookPayload({ key: "k", account: "a" });
  assert.equal(p.command, "cancelallorders");
  assert.equal(p.destination, "tradovate");
});

test("payload builders reject empty key/account (never send an unaddressable close)", () => {
  assert.throws(() => buildFlattenWebhookPayload({ key: "", account: "a" }));
  assert.throws(() => buildFlattenWebhookPayload({ key: "k", account: "  " }));
  assert.throws(() => buildCancelAllWebhookPayload({ key: "k", account: "" }));
});
