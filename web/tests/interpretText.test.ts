/* MACRO INTERPRETATION (lib/macroGuide.ts + lib/interpretText.ts) —
 * offline tests for the guide data, the DeepSeek payload builder, the
 * JSON-mode response parser, the deterministic fallback renderer and
 * the merge. Pure modules: no feeds, no DB, no timers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FAMILIES, METRIC_GUIDES, guideFor, type MetricFamily } from "../lib/macroGuide";
import {
  buildInterpretPayload,
  mergeInterpretContent,
  parseInterpretContent,
  renderDeterministicInterpret,
  applicableGuideLine,
  familyStanceOf,
  type InterpretMetricValue,
  type InterpretSnapshot,
} from "../lib/interpretText";

/* ---------------- guide data integrity ---------------------------- */

test("guide: every metric id is unique", () => {
  const ids = METRIC_GUIDES.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("guide: every metric belongs to a declared family", () => {
  const famIds = new Set<MetricFamily>(FAMILIES.map((f) => f.id));
  for (const g of METRIC_GUIDES) assert.ok(famIds.has(g.family), `${g.id} family ${g.family} not declared`);
});

test("guide: every family has at least one metric", () => {
  for (const f of FAMILIES) {
    assert.ok(METRIC_GUIDES.some((g) => g.family === f.id), `family ${f.id} has no metrics`);
  }
});

test("guide: every metric has a way to read it (up/down and/or read)", () => {
  for (const g of METRIC_GUIDES) {
    assert.ok(g.up || g.down || g.read, `${g.id} has no interpretation text`);
    assert.ok(g.what, `${g.id} has no what`);
  }
});

/* ---------------- deterministic renderer -------------------------- */

function fakeSnapshot(over: Partial<InterpretMetricValue>[] = []): InterpretSnapshot {
  const metrics: InterpretMetricValue[] = METRIC_GUIDES.map((g) => ({
    id: g.id,
    label: g.label,
    family: g.family,
    value: "1.00",
    direction: null,
    num: 1,
    delta: null,
  }));
  for (const o of over) {
    const i = metrics.findIndex((m) => m.id === o.id);
    if (i >= 0) metrics[i] = { ...metrics[i], ...o };
  }
  return {
    generatedAt: "2026-10-06T13:20:00.000Z",
    etDay: "2026-10-06",
    etClock: "09:20",
    metrics,
    staleness: { bonds: false, news: false, earnings: false },
    errors: [],
  };
}

test("deterministic: covers every snapshot metric and every family", () => {
  const s = fakeSnapshot();
  const det = renderDeterministicInterpret(s);
  assert.equal(det.metrics.length, s.metrics.length);
  assert.equal(det.families.length, FAMILIES.length);
  for (const f of det.families) assert.ok(f.read.length > 0);
  for (const m of det.metrics) assert.ok(m.read.length > 0);
});

test("deterministic: all risk-on votes produce a risk-on combined stance", () => {
  const over: Partial<InterpretMetricValue>[] = [];
  for (const g of METRIC_GUIDES) {
    if (g.riskOnWhen) over.push({ id: g.id, direction: g.riskOnWhen });
  }
  const det = renderDeterministicInterpret(fakeSnapshot(over));
  assert.equal(det.combined.stance, "risk-on");
});

test("deterministic: a clean risk-off sweep flips the stance", () => {
  const over: Partial<InterpretMetricValue>[] = [];
  for (const g of METRIC_GUIDES) {
    if (g.riskOnWhen) over.push({ id: g.id, direction: g.riskOnWhen === "up" ? "down" : "up" });
  }
  const det = renderDeterministicInterpret(fakeSnapshot(over));
  assert.equal(det.combined.stance, "risk-off");
});

test("familyStanceOf: ties resolve to mixed", () => {
  const s = fakeSnapshot();
  const fam = s.metrics.filter((m) => m.family === "risk");
  assert.equal(familyStanceOf(fam), "mixed");
});

test("applicableGuideLine: picks up/down/read in order", () => {
  const g = guideFor("vix.level")!;
  assert.equal(applicableGuideLine(g, "up"), g.up);
  assert.equal(applicableGuideLine(g, "down"), g.down);
  assert.equal(applicableGuideLine(g, "flat"), g.read ?? g.what);
  const cal = guideFor("calendar.opex")!;
  assert.equal(applicableGuideLine(cal, null), cal.read);
});

/* ---------------- payload builder --------------------------------- */

test("payload: carries every metric with its guide text", () => {
  const s = fakeSnapshot();
  const p = buildInterpretPayload(s, "deepseek-v4-pro");
  assert.equal(p.model, "deepseek-v4-pro");
  assert.equal(p.response_format.type, "json_object");
  const user = JSON.parse(p.messages[1].content);
  assert.equal(user.snapshot.metrics.length, s.metrics.length);
  const vix = user.snapshot.metrics.find((m: { id: string }) => m.id === "vix.level");
  assert.ok(vix.upMeans && vix.downMeans);
});

/* ---------------- parser ------------------------------------------ */

test("parser: accepts a clean response", () => {
  const parsed = parseInterpretContent(
    JSON.stringify({
      combined: { headline: "h", stance: "risk-on", read: ["a"], caveats: ["b"] },
      families: [{ id: "risk", read: "f" }],
      metrics: [{ id: "vix.level", read: "m" }],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.combined?.stance, "risk-on");
  assert.equal(parsed?.families.length, 1);
  assert.equal(parsed?.metrics.length, 1);
});

test("parser: unwraps markdown fences and drops unknown ids", () => {
  const parsed = parseInterpretContent(
    '```json\n{"families":[{"id":"risk","read":"f"},{"id":"bogus","read":"x"}],"metrics":[{"id":"vix.level","read":"m"}]}\n```',
  );
  assert.ok(parsed);
  assert.equal(parsed?.families.length, 1);
  assert.equal(parsed?.families[0].id, "risk");
});

test("parser: tolerates literal newlines inside strings", () => {
  const parsed = parseInterpretContent('{"metrics":[{"id":"vix.level","read":"line one\nline two"}]}');
  assert.ok(parsed);
  assert.equal(parsed?.metrics[0].read, "line one\nline two");
});

test("parser: garbage returns null", () => {
  assert.equal(parseInterpretContent("not json"), null);
  assert.equal(parseInterpretContent(""), null);
  assert.equal(parseInterpretContent(null), null);
});

test("parser: invalid stance is dropped so the merge falls back", () => {
  const parsed = parseInterpretContent(JSON.stringify({ combined: { stance: "sideways" } }));
  assert.ok(parsed);
  assert.equal(parsed?.combined?.stance, undefined);
});

/* ---------------- merge ------------------------------------------- */

test("merge: LLM wins where valid, deterministic fills the gaps", () => {
  const s = fakeSnapshot([{ id: "vix.level", direction: "up" }]);
  const det = renderDeterministicInterpret(s);
  const parsed = parseInterpretContent(
    JSON.stringify({
      combined: { stance: "bogus", headline: "llm headline" },
      families: [{ id: "risk", read: "llm family" }],
      metrics: [{ id: "vix.level", read: "llm metric" }],
    }),
  );
  const merged = mergeInterpretContent(parsed, det, s);
  assert.equal(merged.combined.headline, "llm headline");
  assert.equal(merged.combined.stance, det.combined.stance); // bogus → fallback
  assert.equal(merged.families.find((f) => f.id === "risk")?.read, "llm family");
  assert.equal(merged.metrics.find((m) => m.id === "vix.level")?.read, "llm metric");
  // a metric the LLM skipped still gets the deterministic read
  const dxy = merged.metrics.find((m) => m.id === "dxy");
  assert.equal(dxy?.read, det.metrics.find((m) => m.id === "dxy")?.read);
});

test("merge: null parsed content returns the deterministic content", () => {
  const s = fakeSnapshot();
  const det = renderDeterministicInterpret(s);
  const merged = mergeInterpretContent(null, det, s);
  assert.deepEqual(merged, det);
});
