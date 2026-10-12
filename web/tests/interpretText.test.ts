/* MACRO INTERPRETATION (lib/macroGuide.ts + lib/interpretText.ts) —
 * offline tests for the guide data, the news-event catalog, the
 * DeepSeek payload builder, the JSON-mode response parser, the
 * deterministic fallback renderer and the merge. Pure modules: no
 * feeds, no DB, no timers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FAMILIES, METRIC_GUIDES, newsGuideFor, guideFor, type MetricFamily } from "../lib/macroGuide";
import {
  buildInterpretPayload,
  mergeInterpretContent,
  parseInterpretContent,
  renderDeterministicInterpret,
  applicableGuideLine,
  familyStanceOf,
  newsNqImpactOf,
  type InterpretMetricValue,
  type InterpretNewsItem,
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

test("guide: every metric has a way to read it and an NQ impact", () => {
  for (const g of METRIC_GUIDES) {
    assert.ok(g.up || g.down || g.read, `${g.id} has no interpretation text`);
    assert.ok(g.what, `${g.id} has no what`);
    assert.ok(g.nqImpact, `${g.id} has no nqImpact`);
  }
});

test("news catalog: patterns match the events the calendar shows", () => {
  const titles = [
    "Core CPI m/m",
    "CPI y/y",
    "Core PPI m/m",
    "Retail Sales m/m",
    "Unemployment Claims",
    "Philly Fed Manufacturing Index",
    "Fed Chairman Warsh Speaks",
    "Nonfarm Payrolls",
    "FOMC Statement",
  ];
  for (const t of titles) {
    const g = newsGuideFor(t);
    assert.ok(g.what && g.nqImpact && g.goodForNq && g.badForNq, `${t} → guide`);
  }
  // the specific patterns must beat the generic fallback
  assert.equal(newsGuideFor("Core CPI m/m").pattern.toString(), /CPI/i.toString());
  assert.equal(newsGuideFor("Fed Chairman Warsh Speaks").pattern.toString(), /Speaks|Testimony/i.toString());
  assert.equal(newsGuideFor("FOMC Statement").pattern.toString(), /FOMC|Federal Funds Rate|Interest Rate Decision/i.toString());
});

/* ---------------- deterministic renderer -------------------------- */

function fakeNews(over: Partial<InterpretNewsItem> = {}): InterpretNewsItem {
  return {
    id: "2026-10-14|08:30|Core CPI m/m",
    title: "Core CPI m/m",
    day: "2026-10-14",
    timeET: "08:30",
    impact: "High",
    forecast: "0.2%",
    previous: "0.3%",
    actual: null,
    released: false,
    ...over,
  };
}

function fakeSnapshot(over: Partial<InterpretMetricValue>[] = [], news: InterpretNewsItem[] = []): InterpretSnapshot {
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
    tape: {
      lastClose: 30600,
      prevSessionClose: 30550,
      changePct: 0.16,
      sessionHigh: 30640,
      sessionLow: 30510,
      closePosPct: 70,
      cumulativeDelta: 4200,
      realizedBandPct: 0.42,
      bars: 900,
    },
    metrics,
    news,
    staleness: { bonds: false, news: false, earnings: false },
    errors: [],
  };
}

test("deterministic: covers every metric, family and news item with explain+nqImpact", () => {
  const s = fakeSnapshot([], [fakeNews()]);
  const det = renderDeterministicInterpret(s);
  assert.equal(det.metrics.length, s.metrics.length);
  assert.equal(det.families.length, FAMILIES.length);
  assert.equal(det.news.length, s.news.length);
  for (const f of det.families) assert.ok(f.explain.length > 0 && f.nqImpact.length > 0);
  for (const m of det.metrics) assert.ok(m.explain.length > 0 && m.nqImpact.length > 0);
  for (const n of det.news) assert.ok(n.explain.length > 0 && n.nqImpact.length > 0);
});

test("deterministic: the combined headline carries the tape", () => {
  const det = renderDeterministicInterpret(fakeSnapshot());
  assert.match(det.combined.headline, /\+0\.16%/);
  assert.ok(det.combined.read.some((l) => l.startsWith("tape:")));
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

/* ---------------- news deterministic reads ------------------------ */

test("news: pre-release read is the conditional beat/miss line", () => {
  const it = fakeNews({ actual: null, released: false });
  const read = newsNqImpactOf(it);
  assert.match(read, /before release/);
});

test("news: a hot CPI release judges bad for NQ (lower is good)", () => {
  const hot = newsNqImpactOf(fakeNews({ actual: "0.5%", forecast: "0.2%", released: true }));
  assert.match(hot, /actual 0\.5% vs 0\.2% f/);
  assert.match(hot, /hawkish/);
  const cool = newsNqImpactOf(fakeNews({ actual: "0.1%", forecast: "0.2%", released: true }));
  assert.match(cool, /cuts stay priced/);
});

test("news: retail sales beat is good (higher is good)", () => {
  const g = newsGuideFor("Retail Sales m/m");
  assert.equal(g.goodWhen, "higher");
  const beat = newsNqImpactOf({
    id: "x",
    title: "Retail Sales m/m",
    day: "2026-10-15",
    timeET: "08:30",
    impact: "High",
    forecast: "0.3%",
    previous: "0.2%",
    actual: "0.7%",
    released: true,
  });
  const miss = newsNqImpactOf({
    id: "x",
    title: "Retail Sales m/m",
    day: "2026-10-15",
    timeET: "08:30",
    impact: "High",
    forecast: "0.3%",
    previous: "0.2%",
    actual: "-0.2%",
    released: true,
  });
  assert.ok(beat !== miss);
  assert.match(beat, /vs 0\.3% f/);
});

/* ---------------- payload builder --------------------------------- */

test("payload: carries every metric, guide text and news item", () => {
  const s = fakeSnapshot([], [fakeNews()]);
  const p = buildInterpretPayload(s, "deepseek-v4-pro");
  assert.equal(p.model, "deepseek-v4-pro");
  assert.equal(p.response_format.type, "json_object");
  const user = JSON.parse(p.messages[1].content);
  assert.equal(user.snapshot.metrics.length, s.metrics.length);
  assert.equal(user.snapshot.news.length, 1);
  assert.ok(user.snapshot.tape.changePct === 0.16);
  const vix = user.snapshot.metrics.find((m: { id: string }) => m.id === "vix.level");
  assert.ok(vix.upMeans && vix.downMeans && vix.nqImpactHint);
});

/* ---------------- parser ------------------------------------------ */

test("parser: accepts a clean two-part response", () => {
  const parsed = parseInterpretContent(
    JSON.stringify({
      combined: { headline: "h", stance: "risk-on", read: ["a"], caveats: ["b"] },
      families: [{ id: "risk", explain: "f", nqImpact: "n" }],
      metrics: [{ id: "vix.level", explain: "m", nqImpact: "nq" }],
      news: [{ id: "2026-10-14|08:30|Core CPI m/m", explain: "e", nqImpact: "nq" }],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.combined?.stance, "risk-on");
  assert.equal(parsed?.families[0].nqImpact, "n");
  assert.equal(parsed?.metrics[0].nqImpact, "nq");
  assert.equal(parsed?.news[0].explain, "e");
});

test("parser: tolerates the legacy single `read` field", () => {
  const parsed = parseInterpretContent(JSON.stringify({ metrics: [{ id: "vix.level", read: "legacy" }] }));
  assert.ok(parsed);
  assert.equal(parsed?.metrics[0].explain, "legacy");
});

test("parser: unwraps markdown fences and drops unknown ids", () => {
  const parsed = parseInterpretContent(
    '```json\n{"families":[{"id":"risk","explain":"f"},{"id":"bogus","explain":"x"}],"metrics":[{"id":"vix.level","explain":"m"}]}\n```',
  );
  assert.ok(parsed);
  assert.equal(parsed?.families.length, 1);
  assert.equal(parsed?.families[0].id, "risk");
});

test("parser: tolerates literal newlines inside strings", () => {
  const parsed = parseInterpretContent('{"metrics":[{"id":"vix.level","explain":"line one\nline two"}]}');
  assert.ok(parsed);
  assert.equal(parsed?.metrics[0].explain, "line one\nline two");
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
  const s = fakeSnapshot([{ id: "vix.level", direction: "up" }], [fakeNews()]);
  const det = renderDeterministicInterpret(s);
  const parsed = parseInterpretContent(
    JSON.stringify({
      combined: { stance: "bogus", headline: "llm headline" },
      families: [{ id: "risk", explain: "llm family", nqImpact: "llm nq" }],
      metrics: [{ id: "vix.level", explain: "llm metric", nqImpact: "llm metric nq" }],
      news: [{ id: "2026-10-14|08:30|Core CPI m/m", explain: "llm news", nqImpact: "llm news nq" }],
    }),
  );
  const merged = mergeInterpretContent(parsed, det, s);
  assert.equal(merged.combined.headline, "llm headline");
  assert.equal(merged.combined.stance, det.combined.stance); // bogus → fallback
  assert.equal(merged.families.find((f) => f.id === "risk")?.nqImpact, "llm nq");
  assert.equal(merged.metrics.find((m) => m.id === "vix.level")?.explain, "llm metric");
  assert.equal(merged.news[0].nqImpact, "llm news nq");
  // a metric the LLM skipped still gets the deterministic read
  const dxy = merged.metrics.find((m) => m.id === "dxy");
  assert.equal(dxy?.explain, det.metrics.find((m) => m.id === "dxy")?.explain);
  assert.equal(dxy?.nqImpact, det.metrics.find((m) => m.id === "dxy")?.nqImpact);
});

test("merge: null parsed content returns the deterministic content", () => {
  const s = fakeSnapshot([], [fakeNews()]);
  const det = renderDeterministicInterpret(s);
  const merged = mergeInterpretContent(null, det, s);
  assert.deepEqual(merged, det);
});
