/* Wall-stop regression tests (offline — no network, fake walls). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWallStop, WALL_STOP_DEFAULTS } from "../lib/wallStop.ts";

test("long: put wall just below the stop widens the stop to the far side", () => {
  const r = applyWallStop(
    { dir: "long", stop: 31100, entry: 31105 },
    [
      { kind: "put", p: 31096 },
      { kind: "call", p: 31240 },
    ],
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.widened, true);
  assert.equal(r.stop, 31096 - 0.5);
  assert.equal(r.wall?.p, 31096);
  assert.match(r.note, /put wall 31096/);
});

test("short: call wall just above the stop widens the stop upward", () => {
  const r = applyWallStop(
    { dir: "short", stop: 31100, entry: 31095 },
    [{ kind: "call", p: 31106 }, { kind: "put", p: 31020 }],
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.widened, true);
  assert.equal(r.stop, 31106 + 0.5);
});

test("wall beyond nearPts does nothing", () => {
  const r = applyWallStop(
    { dir: "long", stop: 31100, entry: 31105 },
    [{ kind: "put", p: 31080 }], // 20 pts away
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.widened, false);
  assert.equal(r.stop, 31100);
});

test("the wrong-kind wall never touches the stop (call wall for a long)", () => {
  const r = applyWallStop(
    { dir: "long", stop: 31100, entry: 31105 },
    [{ kind: "call", p: 31095 }],
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.widened, false);
});

test("only widens, never tightens: a wall inside the risk never moves the stop", () => {
  const r = applyWallStop(
    { dir: "long", stop: 31100, entry: 31105 },
    [{ kind: "put", p: 31103 }], // between entry and stop — not beyond the stop
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.widened, false);
  assert.equal(r.stop, 31100);
});

test("picks the FURTHEST qualifying wall when several are near", () => {
  const r = applyWallStop(
    { dir: "long", stop: 31100, entry: 31105 },
    [
      { kind: "put", p: 31097 },
      { kind: "put", p: 31094 },
    ],
    WALL_STOP_DEFAULTS,
  );
  assert.equal(r.stop, 31094 - 0.5);
});
