/* Registry invariants — the declaration layer can never drift from the
 * code that trades (config objects by reference) or from the study
 * catalog (every study id must exist in lib/studies.ts). */

import { test } from "node:test";
import assert from "node:assert";
import {
  STRATEGIES,
  strategyById,
  liveStrategies,
  strategiesForStudy,
  fieldRows,
  labelFor,
} from "../lib/strategies/registry";
import { MOM_PROD, EXP_PROD } from "../lib/momentum";
import { SOFT_PROD } from "../lib/softMomentum";
import { OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "../lib/openDrive";
import { SWEEP_RECLAIM_V2_DEFAULTS } from "../lib/sweepReclaimV2";
import { studies } from "../lib/studies";
import { FAMILY_LABEL } from "../lib/familyNames";

const studyIds = new Set(studies.map((s) => s.id));

test("ids are unique", () => {
  const ids = STRATEGIES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("config objects are referenced, not copied (identity with the trading code)", () => {
  assert.equal(strategyById("failed_flush_breakout")!.config, MOM_PROD as unknown as Record<string, unknown>);
  assert.equal(strategyById("huge_bar_expansion")!.config, EXP_PROD as unknown as Record<string, unknown>);
  assert.equal(strategyById("session_continuation")!.config, SOFT_PROD as unknown as Record<string, unknown>);
  assert.equal(strategyById("open_drive")!.config, OPEN_PROD as unknown as Record<string, unknown>);
  assert.equal(strategyById("open_pullback")!.config, PULLBACK_PROD as unknown as Record<string, unknown>);
  assert.equal(strategyById("open_sniper")!.config, SNIPER_PROD as unknown as Record<string, unknown>);
  assert.equal(
    strategyById("sweep_reclaim")!.config,
    SWEEP_RECLAIM_V2_DEFAULTS as unknown as Record<string, unknown>,
  );
});

test("every declared study id exists in the catalog", () => {
  const missing: string[] = [];
  for (const s of STRATEGIES) for (const id of s.studies) if (!studyIds.has(id)) missing.push(`${s.id} → ${id}`);
  assert.deepEqual(missing, []);
});

test("every family key has a label", () => {
  for (const s of STRATEGIES) assert.ok(FAMILY_LABEL[s.family], `no label for family ${s.family}`);
});

test("live status matches the live feed defaults (FEED_MOMENTUM/FEED_RTH/FEED_OPEN_DRIVE on)", () => {
  const live = liveStrategies().map((s) => s.id).sort();
  assert.deepEqual(live, ["failed_flush_breakout", "huge_bar_expansion", "open_drive", "session_continuation"]);
});

test("fieldRows renders values from the live object", () => {
  const mom = strategyById("failed_flush_breakout")!;
  const rows = fieldRows(mom);
  const breakFrac = rows.find((r) => r.key === "breakFrac");
  assert.ok(breakFrac);
  assert.equal(breakFrac!.value, "0.72"); // if MOM_PROD changes, this test pins the render, not the value
  assert.equal(typeof MOM_PROD.breakFrac, "number"); // sanity: value came from the object
});

test("strategiesForStudy reverse index works both directions", () => {
  const forMomentum = strategiesForStudy("momentum-study");
  assert.ok(forMomentum.some((s) => s.id === "failed_flush_breakout"));
  for (const s of forMomentum) assert.ok(s.studies.includes("momentum-study"));
});

test("labels are non-empty for every strategy", () => {
  for (const s of STRATEGIES) assert.ok(labelFor(s).length > 0, `empty label for ${s.id}`);
});
