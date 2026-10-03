/* The Python engine (gcdata/profiles.py) and the TypeScript engine
 * (../lib/gcdata.ts) must produce IDENTICAL level sheets — they are two
 * implementations of the same definition, and the 2026 audit found them
 * disagreeing (banker's rounding + a missing LVN width filter). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { WEB, DATE } from "./helpers.mjs";
import { computeSheet } from "../lib/gcdata.ts";

const GC = path.join(WEB, "..", "gcdata");
const PY = path.join(GC, ".venv", "bin", "python");

test(
  "python and TypeScript level sheets agree exactly",
  {
    skip:
      (!process.env.PARITY_NET && "network test — run with PARITY_NET=1 to hit GoCharting live") ||
      (!existsSync(PY) && "no python venv available"),
  },
  async () => {
  const raw = execFileSync(PY, ["collect.py", "--level-sheet", "--today", DATE], {
    cwd: GC,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
  const py = JSON.parse(raw);
  const ts = (await computeSheet(DATE)).profiles;
  const n = (x) => Number(String(x).replace(/,/g, ""));

  const profiles = Object.keys(ts).filter((k) => ts[k]);
  assert.ok(profiles.length >= 6, `${profiles.length} profiles compared`);
  for (const k of profiles) {
    assert.ok(py[k], `python sheet has ${k}`);
    assert.equal(py[k].total, ts[k].total, `${k} total`);
    for (const f of ["POC", "VAH", "VAL"]) {
      assert.equal(n(py[k][f]), n(ts[k][f]), `${k} ${f}`);
    }
    assert.equal(py[k].rows, ts[k].rows, `${k} rows`);
    assert.deepEqual(py[k].LVNs, ts[k].LVNs, `${k} LVN zones (incl. the en-dash separator)`);
  }
});
