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
  assert.equal(rows[0].anatomy.family, "rth");
  assert.equal(rows[0].anatomy.mfe, 2.5);
});

const blob = (): string => JSON.stringify({ a: Array.from({ length: 40 }, (_, i) => i) });
