/* BRIEFING TEXT (lib/briefingText.ts) — offline tests for the DeepSeek
 * payload builder, the JSON-mode response parser, and the deterministic
 * fallback renderer. Pure module: no feeds, no DB, no timers. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefingPayload,
  parseBriefingContent,
  renderDeterministicBriefing,
  chartLinesOfSnapshot,
  systemVerdictOf,
  enforceHeadlineBias,
  type BriefingSnapshot,
} from "../lib/briefingText";

function snapshot(over: Partial<BriefingSnapshot> = {}): BriefingSnapshot {
  const base: BriefingSnapshot = {
    kind: "pre-open",
    generatedAt: "2026-10-05T13:15:00.000Z",
    etDay: "2026-10-05",
    etClock: "09:15",
    marketOpen: true,
    sessionDay: "2026-10-05",
    nq: {
      lastClose: 30700,
      prevSessionClose: 30650,
      changePct: 0.16,
      sessionHigh: 30710,
      sessionLow: 30610,
      cumulativeDelta: 4200,
      volume: 512000,
      realizedBandPct: 0.42,
      vixBandPct: 0.55,
      vixBandPts: 168.9,
      bars: 916,
      firstBar: "2026-10-04T22:00:00.000Z",
      lastBar: "2026-10-05T13:14:00.000Z",
      closePosPct: 70,
      prevHigh: 30680,
      prevLow: 30540,
      prevCumulativeDelta: -1200,
      prevClosePosPct: 88,
      levels: [
        { label: "GEX flip", value: "30,540", note: "below it dealers sell into weakness — dips accelerate" },
        { label: "call wall", value: "31,020", note: "overhead gamma — the magnet that caps rallies" },
        { label: "session high", value: "30,710", note: "clearing it confirms the bid" },
        { label: "session low", value: "30,610", note: "losing it ends the read" },
      ],
      lines: [
        { label: "GEX flip", price: 30540, tone: "flip" },
        { label: "call wall", price: 31020, tone: "call wall" },
        { label: "session high", price: 30710, tone: "high" },
        { label: "session low", price: 30610, tone: "low" },
      ],
    },
    rates: {
      y2: 3.9, y10: 4.1, y30: 4.6, curveDate: "2026-10-02",
      y10ChangeBps: 3, spread210: 20, spread103m: -12, breakeven10y: 2.3, real10y: 1.8,
      effr: { date: "2026-10-02", rate: 3.85, targetFrom: 3.75, targetTo: 4.0 },
      intraday: { y2: 3.91, y10: 4.12, asOf: "2026-10-05T13:00:00-04:00" },
      impliedFfr: 3.88,
    },
    news: {
      source: "forexfactory",
      fetchedAt: "2026-10-05T13:10:00.000Z",
      today: [
        { day: "2026-10-05", timeET: "10:00", title: "ISM Services PMI", impact: "High", forecast: "52.5", previous: "52.0", released: false },
      ],
      upcoming: [{ day: "2026-10-08", timeET: "08:30", title: "CPI", impact: "High", forecast: "0.2%", previous: "0.3%", released: false }],
    },
    earnings: {
      provider: "nasdaq",
      asOf: "2026-10-05",
      today: [],
      upcoming: [{ symbol: "TSLA", nextDate: "2026-10-21", nextTime: "amc", nextEpsEst: 0.71, nextEstimated: true }],
    },
    watch: {
      quotesAt: "2026-10-05T13:14:00.000Z",
      quotes: [
        { symbol: ".VIX", label: "VIX", value: 16.2, changePct: -4.1 },
        { symbol: ".DXY", label: "DXY", value: 101.9, changePct: -0.2 },
        { symbol: ".SPX", label: "S&P 500", value: 6300, changePct: 0.4 },
        { symbol: ".NDX", label: "Nasdaq-100", value: 20500, changePct: 0.5 },
        { symbol: ".SOX", label: "SOX semis", value: 7800, changePct: 2.4 },
        { symbol: "RSP", label: "RSP eq-wt", value: 178, changePct: 0.2 },
      ],
      vix: { level: 16.2, pct1y: 15, rangePct: 1.01, at: "2026-10-02" },
      gex: { regime: "trend", spot: 505, flip: 502, callWall: 510, putWall: 495, unit: "QQQ points" },
      htf: { daily: "HH/HL", weekly: "HH/HL", at: "2026-10-02" },
      fred: { hyOasPct: 3.4, hyOasDelta: -0.2, walclT: 6.4, walclDeltaT: -0.03, rrpB: 210, tgaB: 720, at: "2026-10-02" },
      cot: { netPctOi: 8.2, pct52w: 88, asOf: "2026-09-29" },
      calendar: {
        opex: { day: "2026-10-16", quad: false, days: 11 },
        auctions: [{ label: "10Y", day: "2026-10-07", days: 2 }],
        fomcMinutes: { day: "2026-10-21", days: 16, approx: true },
      },
      errors: [],
    },
    staleness: {
      bonds: { ok: true, stale: false, fetchedAt: "2026-10-05T13:10:00.000Z", error: null },
      news: { ok: true, stale: false, fetchedAt: "2026-10-05T13:10:00.000Z", error: null },
      earnings: { ok: true, stale: false, fetchedAt: "2026-10-05T13:10:00.000Z", error: null },
    },
    systemVerdict: { bias: "up", vol: "normal", evidence: ["+1 chg 0.16%"] },
  };
  return { ...base, ...over };
}

test("payload: JSON-mode shape, thinking disabled, bias enum in prompt", () => {
  const s = snapshot();
  const p = buildBriefingPayload(s, "deepseek-v4-pro");
  assert.equal(p.model, "deepseek-v4-pro");
  assert.equal(p.response_format.type, "json_object");
  assert.equal(p.thinking.type, "disabled", "thinking off so reasoning tokens cannot starve the JSON");
  assert.ok(p.max_tokens >= 500, "max_tokens set so JSON is not truncated");
  const system = p.messages.find((m) => m.role === "system");
  assert.ok(system, "system prompt present");
  assert.match(system!.content.toLowerCase(), /json/i, "JSON mode requires the word json in the prompt");
  assert.match(system!.content, /bias is pre-decided/i, "bias comes from systemVerdict, not the model");
  assert.match(system!.content, /never invent other prices/i, "model must not invent prices");
  assert.match(system!.content, /scalper reads your output between ticks/i, "brevity-first framing");
  const user = p.messages.find((m) => m.role === "user");
  const j = JSON.parse(user!.content);
  assert.equal(j.snapshot.kind, "pre-open");
  assert.equal(j.snapshot.systemVerdict.bias, "up", "verdict rides in the snapshot");
  assert.ok(!("bias" in j.exampleJsonOutput), "schema example has no bias field — the system decides");
  assert.ok(Array.isArray(j.exampleJsonOutput.watchFors), "watchFors are in the schema example");
  assert.ok(j.snapshot.nq.levels.length > 0, "snapshot carries the precomputed NQ levels");
});

test("parseBriefingContent: valid object round-trips", () => {
  const c = parseBriefingContent(JSON.stringify({
    headline: "UP · NQ 30,700", bias: "up", vol: "elevated",
    read: ["d1"], watchFors: ["w1"], caveats: ["c1"],
  }));
  assert.ok(c);
  assert.equal(c!.bias, "up");
  assert.deepEqual(c!.read, ["d1"]);
  assert.deepEqual(c!.watchFors, ["w1"]);
  assert.deepEqual(c!.caveats, ["c1"]);
});

test("parseBriefingContent: junk filtered, defaults safe", () => {
  const c = parseBriefingContent(JSON.stringify({
    headline: "h",
    read: ["a", 42, "", "b"],
    watchFors: [null, "w"],
    caveats: ["", "c"],
  }));
  assert.ok(c);
  assert.equal(c!.bias, "chop");
  assert.equal(c!.vol, "normal");
  assert.deepEqual(c!.read, ["a", "b"]);
  assert.deepEqual(c!.watchFors, ["w"]);
  assert.deepEqual(c!.caveats, ["c"]);
});

test("parseBriefingContent: fenced JSON is unwrapped", () => {
  const c = parseBriefingContent('```json\n{"headline":"fenced","bias":"down"}\n```');
  assert.ok(c);
  assert.equal(c!.headline, "fenced");
  assert.equal(c!.bias, "down");
});

test("parseBriefingContent: garbage / empty / non-object → null", () => {
  assert.equal(parseBriefingContent("not json at all"), null);
  assert.equal(parseBriefingContent(""), null);
  assert.equal(parseBriefingContent(null), null);
  assert.equal(parseBriefingContent(JSON.stringify([1, 2, 3])), null);
  assert.equal(parseBriefingContent(JSON.stringify({ foo: "bar" })), null); // no headline/bias
});

test("deterministic: up-bias, NQ levels, watch-fors from a rich snapshot", () => {
  const c = renderDeterministicBriefing(snapshot());
  assert.equal(c.bias, "up", "tape + HTF + GEX all point up");
  assert.match(c.headline, /UP/, "headline states the bias");
  assert.match(c.headline, /30,?700/, "headline carries the NQ price");
  assert.ok(c.read.length >= 1 && c.read.length <= 2, "why is ≤2 bullets");
  assert.ok(c.read.some((d) => d.includes("semis leading")), "breadth becomes a why bullet");
  assert.ok(c.read.some((d) => d.includes("complacency")), "VIX percentile becomes a why bullet");
  assert.ok(c.watchFors.length >= 1 && c.watchFors.length <= 3, "watch-fors capped at 3");
  assert.ok(c.watchFors.some((w) => w.includes("30,610")), "watch-fors reference NQ prices");
  assert.ok(c.watchFors.some((w) => w.includes("30,540")), "GEX flip (NQ) becomes a watch-for");
  assert.ok(c.caveats.some((r) => r.includes("20 min delayed")), "vintage caveat present");
});

test("deterministic: degraded snapshot never crashes, bias chop", () => {
  const empty = snapshot({
    nq: {
      lastClose: null, prevSessionClose: null, changePct: null, sessionHigh: null, sessionLow: null,
      cumulativeDelta: null, volume: null, realizedBandPct: null, vixBandPct: null, vixBandPts: null,
      bars: 0, firstBar: null, lastBar: null, closePosPct: null,
      prevHigh: null, prevLow: null, prevCumulativeDelta: null, prevClosePosPct: null, levels: [], lines: [],
    },
    rates: null,
    news: { source: "static", fetchedAt: null, today: [], upcoming: [] },
    watch: {
      quotesAt: null, quotes: [], vix: null, gex: null, htf: null, fred: null, cot: null,
      calendar: { opex: null, auctions: [], fomcMinutes: null }, errors: ["CNBC batch empty"],
    },
    staleness: {
      bonds: { ok: false, stale: true, fetchedAt: "2026-10-01T00:00:00.000Z", error: "HTTP 500" },
      news: { ok: false, stale: true, fetchedAt: null, error: "mirror 429" },
      earnings: { ok: false, stale: false, fetchedAt: null, error: null },
    },
  });
  const c = renderDeterministicBriefing(empty);
  assert.match(c.headline, /n\/a/, "null price shows as n/a, not NaN");
  assert.equal(c.bias, "chop");
  assert.ok(c.read.some((d) => d.includes("insufficient data")), "no data → honest 'no read' bullet");
  assert.ok(c.watchFors.some((w) => w.includes("no levels available")));
  assert.ok(c.caveats.some((r) => r.includes("bonds/news/earnings stale or unavailable")));
  assert.ok(c.caveats.some((r) => r.includes("watch errors: 1")));
});

test("deterministic: all-null watch/fred/cot fields do not leak NaN or undefined", () => {
  const s = snapshot();
  s.watch.fred = null;
  s.watch.cot = null;
  s.watch.gex = null;
  s.watch.vix = null;
  s.watch.quotes = [];
  const c = renderDeterministicBriefing(s);
  const blob = JSON.stringify(c);
  assert.ok(!blob.includes("NaN"), "no NaN anywhere");
  assert.ok(!blob.includes("undefined"), "no undefined anywhere");
});

test("chartLinesOfSnapshot: colored lines from the snapshot, junk dropped", () => {
  const s = snapshot();
  const lines = chartLinesOfSnapshot(s);
  assert.ok(lines.some((l) => l.label === "GEX flip" && l.price === 30540 && l.color === "#fbbf24"));
  assert.ok(lines.some((l) => l.label === "call wall" && l.color === "#38bdf8"));
  assert.ok(lines.some((l) => l.label === "session low" && l.color === "#a1a1aa"));

  // loose jsonb shape: numeric strings coerce, junk entries dropped
  const loose = chartLinesOfSnapshot({
    nq: { lines: [{ label: "GEX flip", price: "30540", tone: "flip" }, null, 42, { nope: true }, { label: "x" }] },
  });
  assert.equal(loose.length, 1);
  assert.equal(loose[0].price, 30540);

  assert.deepEqual(chartLinesOfSnapshot(null), []);
  assert.deepEqual(chartLinesOfSnapshot({ nq: {} }), []);
});

test("parseBriefingContent: repairs literal newlines inside strings (the live failure mode)", () => {
  const raw = '{\n  "headline": "Chop: closed at 55% of range",\n  "bias": "chop",\n  "read": [\n    "Tape absent Monday; Friday VIX 15.31,\nrange 0.96%, cumulative delta -5,378.",\n    "second line"\n  ],\n  "watchFors": ["reclaim 31,283 flips up"],\n  "caveats": []\n}';
  const c = parseBriefingContent(raw);
  assert.ok(c, "repaired JSON parses");
  assert.equal(c!.bias, "chop");
  assert.equal(c!.read.length, 2);
  assert.match(c!.read[0], /VIX 15\.31/);
});

test("parseBriefingContent: repairs fenced JSON with trailing prose", () => {
  const raw = 'Here you go:\n```json\n{"headline":"UP NQ 31,049","bias":"up","read":[],"watchFors":[],"caveats":[]}\n```\nDone.';
  const c = parseBriefingContent(raw);
  assert.ok(c);
  assert.equal(c!.bias, "up");
});

test("systemVerdictOf: code-decided, stable across calls, evidence attached", () => {
  const s = snapshot();
  const v1 = systemVerdictOf(s);
  const v2 = systemVerdictOf(s);
  assert.deepEqual(v1, v2, "same snapshot → same verdict, always");
  assert.equal(v1.bias, "up");
  assert.equal(v1.vol, "normal");
  assert.ok(v1.evidence.some((e) => e.includes("HTF HH/HL")), "evidence lists the HTF contribution");
  assert.ok(v1.evidence.some((e) => e.includes("score +")), "evidence states the score");
});

test("biasOf: no current tape → prior session fields decide", () => {
  const s = snapshot({
    nq: {
      ...snapshot().nq,
      bars: 0,
      lastClose: null,
      changePct: null,
      sessionHigh: null,
      sessionLow: null,
      cumulativeDelta: null,
      closePosPct: null,
      prevClosePosPct: 72,
      prevCumulativeDelta: -5378,
    },
  });
  const v = systemVerdictOf(s);
  assert.ok(v.evidence.some((e) => e.includes("prior close 72%")), "prior close position is used");
  assert.ok(v.evidence.some((e) => e.includes("prior delta")), "prior delta is used");
  assert.ok(["up", "down", "chop"].includes(v.bias));
  // mid-range (55%) is neutral: no evidence line, still a valid verdict
  const mid = snapshot({
    nq: {
      ...snapshot().nq,
      bars: 0, lastClose: null, changePct: null, sessionHigh: null, sessionLow: null,
      cumulativeDelta: null, closePosPct: null, prevClosePosPct: 55, prevCumulativeDelta: null,
    },
  });
  assert.ok(!systemVerdictOf(mid).evidence.some((e) => e.includes("prior close")), "neutral position contributes nothing");
  assert.ok(["up", "down", "chop"].includes(v.bias));
});

test("enforceHeadlineBias: leading bias word is corrected to the verdict", () => {
  assert.equal(enforceHeadlineBias("Chop: tape hasn't opened", "up"), "Up: tape hasn't opened");
  assert.equal(enforceHeadlineBias("Up until GEX flip holds", "up"), "Up until GEX flip holds");
  assert.equal(enforceHeadlineBias("Down into 30,739", "down"), "Down into 30,739");
  assert.equal(enforceHeadlineBias("Chop until the flip breaks", "chop"), "Chop until the flip breaks");
  // non-leading bias words are not touched (avoid mangling prose)
  assert.equal(enforceHeadlineBias("Range breaks down below 30,739", "up"), "Range breaks down below 30,739");
});
