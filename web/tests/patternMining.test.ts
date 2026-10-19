import { test } from "node:test";
import assert from "node:assert/strict";
import {
  variableType,
  quantileThresholds,
  binLabelOf,
  patternFor,
  minePatterns,
  familyBaselines,
  winLossRowsFromDb,
  signalsToWinLossRows,
} from "../lib/patternMining";

test("binLabelOf brackets values against thresholds", () => {
  const t = [0.5, 1.2];
  assert.equal(binLabelOf(0.3, t), "(−∞, 0.50)");
  assert.equal(binLabelOf(0.5, t), "[0.50, 1.20)");
  assert.equal(binLabelOf(0.8, t), "[0.50, 1.20)");
  assert.equal(binLabelOf(1.2, t), "[1.20, +∞)");
  assert.equal(binLabelOf(3, []), "all");
});

test("quantileThresholds dedupes ties", () => {
  // all ties collapse to one threshold (the caller treats a single
  // bucket as "no direction" — a constant can't separate wins)
  assert.deepEqual(quantileThresholds([1, 1, 1, 1, 1, 1, 1, 1]), [1]);
  assert.deepEqual(quantileThresholds([1, 2, 2, 2, 3]), [2]);
});

test("variableType classifies numeric / categorical / presence", () => {
  assert.equal(variableType([1, 2, 3.5, "4"]), "numeric");
  assert.equal(variableType(["buy", "sell", true, false]), "categorical");
  const blob = JSON.stringify({ a: Array.from({ length: 40 }, (_, i) => i) });
  assert.equal(variableType([blob, blob, blob, 1]), "presence");
});

test("numeric variable: higher → more wins gives direction up and strong effect", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let v = 1; v <= 60; v++) {
    values.push(v);
    results.push(v >= 31 ? "win" : "loss"); // bottom half loses, top half wins
  }
  const p = patternFor("x", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.type, "numeric");
  assert.equal(p.direction, "up");
  assert.match(p.directionLabel, /higher → more wins/);
  assert.ok(p.effectPp >= 90, `effect ${p.effectPp}`);
  assert.equal(p.strength, "strong");
});

test("numeric variable: lower → more wins gives direction down", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let v = 1; v <= 60; v++) {
    values.push(v);
    results.push(v <= 30 ? "win" : "loss");
  }
  const p = patternFor("x", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.direction, "down");
  assert.match(p.directionLabel, /lower → more wins/);
});

test("flat variable: no direction, zero effect", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let v = 1; v <= 64; v++) {
    values.push(v);
    results.push(v % 2 === 0 ? "win" : "loss"); // 8W/8L in every 16-row bin
  }
  const p = patternFor("x", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.direction, "flat");
  assert.ok(Math.abs(p.effectPp) < 1, `effect ${p.effectPp}`);
  assert.equal(p.strength, "weak");
});

test("categorical variable: split direction names the preferred value", () => {
  const values = ["buy", "buy", "buy", "buy", "sell", "sell", "sell", "sell", "buy", "sell"];
  const results: Array<"win" | "loss"> = ["win", "win", "win", "win", "loss", "loss", "loss", "loss", "win", "loss"];
  const p = patternFor("stack", "fire-time", values, results, 0.5, 2, null)!;
  assert.equal(p.type, "categorical");
  assert.equal(p.direction, "split");
  assert.match(p.directionLabel, /prefers buy/);
});

test("presence variable compares present vs absent", () => {
  const values = [blob(), blob(), blob(), undefined, undefined];
  const results: Array<"win" | "loss"> = ["win", "win", "win", "loss", "loss"];
  const p = patternFor("dom", "fire-time", values, results, 0.4, 2, null)!;
  assert.equal(p.type, "presence");
  assert.equal(p.direction, "split");
  const present = p.cells.find((c) => c.label === "present")!;
  assert.equal(present.wins, 3);
});

test("perFamily lift is vs the family's own baseline", () => {
  const rows = [];
  // family a: 15 win / 5 loss = 75% · family b: 5 win / 12 loss = 29%
  for (let i = 0; i < 20; i++) rows.push({ result: (i < 15 ? "win" : "loss") as "win" | "loss", flat: { x: i }, anatomy: { family: "a" } });
  for (let i = 0; i < 17; i++) rows.push({ result: (i < 5 ? "win" : "loss") as "win" | "loss", flat: { x: 100 + i }, anatomy: { family: "b" } });
  const baselines = familyBaselines(rows);
  assert.ok(Math.abs(baselines.get("a")! - 0.75) < 0.01, `A ${baselines.get("a")}`);
  const mined = minePatterns(rows, { minN: 5, exclude: new Set(), anatomyKeys: ["family"] });
  const familyVar = mined.find((p) => p.key === "family")!;
  const famB = familyVar.perFamily.find((f) => f.family === "b")!;
  assert.ok(Math.abs(famB.wr - baselines.get("b")!) < 0.01, "family lift anchored to the family baseline");
});

test("winLossRowsFromDb maps a trades row: features parsed, pre-trade keys injected, anatomy attached", () => {
  const rows = winLossRowsFromDb([
    {
      result: "win",
      family: "rth",
      side: "long",
      contracts: 3,
      hour_bucket: "rth",
      first_of_day: true,
      time_et: "13:05",
      mfe_pts: 2.5,
      stop_run: false,
      loss_label: "",
      features: JSON.stringify({ breakFrac: 0.7, family: "rth" }),
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, "win");
  assert.equal(rows[0].flat.breakFrac, 0.7);
  assert.equal(rows[0].flat.side, "long", "side injected when absent from features");
  assert.equal(rows[0].flat.contracts, 3);
  assert.equal(rows[0].flat.hourET, 13);
  assert.equal(rows[0].anatomy.family, "session_continuation");
  assert.equal(rows[0].anatomy.mfe, 2.5);
});

const blob = (): string => JSON.stringify({ a: Array.from({ length: 40 }, (_, i) => i) });

/* ---- per-value binning (small integer domains) ---------------------- */

test("contracts-like integers bin per value (1..30), not quantiles", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let i = 0; i < 60; i++) {
    const size = (i % 30) + 1;
    values.push(size);
    results.push(size <= 15 ? "win" : "loss");
  }
  const p = patternFor("contracts", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.type, "numeric");
  assert.equal(p.cells.length, 30, "one cell per size");
  assert.equal(p.cells[0].label, "1");
  assert.equal(p.cells[29].label, "30");
  assert.ok(p.cells.every((c) => c.meanValue !== null && Number.isInteger(c.meanValue)));
});

test("per-value direction: smaller sizes win more → direction down", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let i = 0; i < 60; i++) {
    const size = Math.floor(i / 6) + 1; // sizes 1..10, 6 rows each
    values.push(size);
    results.push(size <= 5 ? "win" : "loss");
  }
  const p = patternFor("contracts", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.direction, "down");
  assert.match(p.directionLabel, /lower → more wins/);
});

test("continuous values still use quantile brackets", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let i = 0; i < 60; i++) {
    values.push(1.5 + i * 0.7); // floats — never per-value
    results.push(i >= 30 ? "win" : "loss");
  }
  const p = patternFor("atr14", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.cells.length, 4, "4 quantile bins");
  assert.ok(p.cells.every((c) => c.label.includes(",") || c.label.includes("∞")));
});

test("wide integer domains (>30 distinct) fall back to quantiles", () => {
  const values: number[] = [];
  const results: Array<"win" | "loss"> = [];
  for (let i = 0; i < 200; i++) {
    values.push(i + 1); // 200 distinct integers
    results.push(i >= 100 ? "win" : "loss");
  }
  const p = patternFor("medVol", "fire-time", values, results, 0.5, 5, null)!;
  assert.equal(p.cells.length, 4);
});

/* ---- the statistical foundation (verdict layer) ---------------------- */

test("signalsToWinLossRows: hypothetical outcomes decide, time/open skipped", () => {
  const rows = signalsToWinLossRows([
    { day: "2026-10-08", time_et: "13:05", side: "long", size: "9 MNQ", verdict: "rth soft-continuation (experimental)", outcome: "win", features: JSON.stringify({ breakFrac: 0.7 }) },
    { day: "2026-10-08", time_et: "13:20", side: "short", size: "9 MNQ", verdict: "momentum (huge-bar expansion · retrace)", outcome: "loss", features: null },
    { day: "2026-10-08", time_et: "13:40", side: "long", size: "9 MNQ", verdict: "rth soft-continuation (experimental)", outcome: "time", features: null }, // skipped
    { day: "2026-10-08", time_et: "13:55", side: "long", size: "9 MNQ", verdict: "rth soft-continuation (experimental)", outcome: "open", features: null }, // skipped
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result, "win");
  assert.equal(rows[0].flat.breakFrac, 0.7);
  assert.equal(rows[0].anatomy.family, "session_continuation");
  assert.equal(rows[0].flat.side, "long");
  assert.equal(rows[0].flat.contracts, 9);
  assert.equal(rows[0].flat.hourBucket, "rth");
  assert.equal(rows[1].result, "loss");
  assert.equal(rows[1].anatomy.family, "huge_bar_expansion");
});

test("minePatterns: a clean consistent variable is significant and ranks first", () => {
  const rows = [];
  for (let v = 1; v <= 60; v++) {
    // winners in the upper third of EACH half — direction "up" holds in
    // both time halves, so the variable is significant AND stable
    const win = v % 60 <= 30 ? v >= 16 : v >= 46;
    rows.push({
      result: (win ? "win" : "loss") as "win" | "loss",
      flat: { x: v + 0.5, y: v % 2 }, // x = continuous (quantile bins) · y = noise
      anatomy: { family: "a" },
    });
  }
  const out = minePatterns(rows, { minN: 5, anatomyKeys: [] });
  const x = out.find((p) => p.key === "x")!;
  const y = out.find((p) => p.key === "y")!;
  assert.equal(out[0].key, "x", "evidence ranking puts the significant variable first");
  assert.equal(x.verdict, "significant");
  assert.ok(x.pValue !== null && x.pValue < 0.001, `p=${x.pValue}`);
  assert.ok(x.qValue !== null && x.qValue < 0.1, `q=${x.qValue}`);
  assert.equal(x.stable, true);
  assert.equal(y.verdict, "stable", "noise-ish split that happens to hold in both halves is stable, not significant");
  assert.ok(y.pValue !== null && y.pValue > 0.5, `noise p=${y.pValue}`);
});

test("minePatterns: significance is rejected when the direction flips across time halves", () => {
  const rows = [];
  for (let v = 1; v <= 60; v++) {
    rows.push({
      result: (v <= 30 ? "win" : "loss") as "win" | "loss", // wins only in the EARLY half
      flat: { z: v },
      anatomy: { family: "a" },
    });
  }
  const out = minePatterns(rows, { minN: 5, anatomyKeys: [] });
  const z = out.find((p) => p.key === "z")!;
  assert.ok(z.pValue !== null && z.pValue < 0.001, "overall association is real");
  assert.equal(z.stable, false, "but it flips across the halves");
  assert.equal(z.verdict, "exploratory", "non-stationary patterns never claim significance");
});

test("minePatterns: stability is unjudgeable on a small sample", () => {
  const rows = [];
  for (let v = 1; v <= 10; v++) {
    rows.push({ result: (v > 5 ? "win" : "loss") as "win" | "loss", flat: { x: v }, anatomy: { family: "a" } });
  }
  const out = minePatterns(rows, { minN: 8, anatomyKeys: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].stable, "insufficient", "10 rows can't be split into two judgeable halves at minN 8");
  // with only one variable tested, FDR = the raw p — significance is not
  // contradicted by stability, so the verdict stands
  assert.equal(out[0].verdict, "significant");
});
