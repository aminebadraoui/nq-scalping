/* ------------------------------------------------------------------ *
 * Interpretation text — PURE module for the Macro tab's AI
 * interpretation layer (per-metric reads, per-family combination
 * reads, per-news-event reads, the combined all-families read).
 *
 * Everything here is a pure function over plain data: the DeepSeek
 * prompt/payload builder, the JSON-mode response parser, the merge
 * (LLM wins where it produced a valid entry, the deterministic
 * renderer fills the rest), and the deterministic fallback itself.
 * No feeds, no DB, no side effects — offline-testable.
 *
 * Each read has TWO parts, per the user's spec:
 *   explain   — what the current value/state means
 *   nqImpact  — what it means for READING NQ
 *
 * The orchestration (snapshot assembly, persistence) lives in
 * lib/macroInterpret.ts. The static up/down guides + the news-event
 * catalog live in lib/macroGuide.ts.
 * DISPLAY-ONLY — the signal engine never imports either module.
 * ------------------------------------------------------------------ */

import {
  FAMILIES,
  guideFor,
  newsGuideFor,
  type MetricFamily,
  type MetricGuide,
} from "./macroGuide";

export type InterpretDirection = "up" | "down" | "flat" | null;

export type InterpretStance = "risk-on" | "risk-off" | "mixed";

/** the NQ session tape — folded in from the retired briefing card so
 *  the combined read covers the tape like the briefing used to */
export type InterpretTape = {
  lastClose: number | null;
  prevSessionClose: number | null;
  changePct: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  /** 0-100: where the last close sits inside the session range */
  closePosPct: number | null;
  cumulativeDelta: number | null;
  /** realized daily 1σ % from the live 1-min tape */
  realizedBandPct: number | null;
  bars: number | null;
};

/** one calendar event, for the per-event explanation + result reads */
export type InterpretNewsItem = {
  id: string;
  title: string;
  day: string;
  timeET: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  released: boolean;
};

/** one metric as the snapshot records it (value pre-formatted) */
export type InterpretMetricValue = {
  id: string;
  label: string;
  family: MetricFamily;
  value: string;
  /** the banded/day-change state; null when non-directional */
  direction: InterpretDirection;
  /** raw numeric value, when one exists */
  num: number | null;
  /** signed day change in native units (quotes/yields), when known */
  delta: number | null;
};

export type InterpretSnapshot = {
  generatedAt: string;
  etDay: string;
  etClock: string;
  /** the NQ session tape (the retired briefing's territory) */
  tape: InterpretTape;
  metrics: InterpretMetricValue[];
  /** this week's US calendar events (up to 14, released first) */
  news: InterpretNewsItem[];
  /** which upstream sources were stale/failed at build time */
  staleness: { bonds: boolean; news: boolean; earnings: boolean };
  errors: string[];
};

export type InterpretCombined = {
  headline: string;
  stance: InterpretStance;
  read: string[];
  caveats: string[];
};

export type InterpretFamilyRead = { id: MetricFamily; stance: InterpretStance; explain: string; nqImpact: string };

export type InterpretMetricRead = { id: string; explain: string; nqImpact: string };

export type InterpretNewsRead = { id: string; explain: string; nqImpact: string };

export type InterpretContent = {
  combined: InterpretCombined;
  families: InterpretFamilyRead[];
  metrics: InterpretMetricRead[];
  news: InterpretNewsRead[];
};

/* ---------------------------------------------------------------- *
 * deterministic renderer
 * ---------------------------------------------------------------- */

/** read-priority inside each family (first = most informative) */
const FAMILY_PRIORITY: Record<MetricFamily, string[]> = {
  risk: ["vix.pct1y", "vix.level", "gex.regime", "gex.flipDist", "gex.callWall", "gex.putWall", "vix.term9d", "vix.term3m", "vix.rangePct"],
  rates: ["rates.spread210", "rates.spread103m", "rates.y10ChangeBps", "rates.y10", "rates.y2", "rates.real10y", "rates.breakeven10y", "rates.ffrImpled", "rates.effr", "rates.y30"],
  "fx-equities": ["sox", "ndx", "spx", "smh", "rsp", "dxy", "qqq", "spy"],
  commodities: ["wti", "gold"],
  crypto: ["btc"],
  liquidity: ["fred.hyOas", "fred.walcl", "cot.netPctOi", "cot.pct52w", "fred.rrp", "fred.tga"],
  calendar: ["news.next", "calendar.opex", "earnings.next", "calendar.fomcMinutes", "calendar.auctions"],
  structure: ["htf.daily", "bias.score", "bias.gapRegime", "bias.gapPct", "bias.fadeOk", "bias.sideLean", "htf.weekly"],
};

const isStance = (v: unknown): v is InterpretStance => v === "risk-on" || v === "risk-off" || v === "mixed";

const DIR_ARROW: Record<Exclude<InterpretDirection, null>, string> = { up: "▲", down: "▼", flat: "•" };

/** the guide line that applies to the metric's current state */
export function applicableGuideLine(g: MetricGuide, dir: InterpretDirection): string {
  if (dir === "up" && g.up) return g.up;
  if (dir === "down" && g.down) return g.down;
  return g.read ?? g.what;
}

/** deterministic explain for a metric: value + the applicable guide */
export function metricExplainOf(m: InterpretMetricValue): string {
  const g = guideFor(m.id);
  if (!g) return `${m.value} — no guide`;
  const line = applicableGuideLine(g, m.direction);
  const dir = m.direction ? `${DIR_ARROW[m.direction]} ` : "";
  return `${dir}${m.value} — ${line}`;
}

export function metricNqImpactOf(m: InterpretMetricValue): string {
  const g = guideFor(m.id);
  return g?.nqImpact ?? "no NQ read";
}

/** risk stance vote of one metric (null = abstains) */
function voteOf(m: InterpretMetricValue): InterpretStance | null {
  const g = guideFor(m.id);
  if (!g?.riskOnWhen || (m.direction !== "up" && m.direction !== "down")) return null;
  return m.direction === g.riskOnWhen ? "risk-on" : "risk-off";
}

export function familyStanceOf(metrics: InterpretMetricValue[]): InterpretStance {
  let on = 0;
  let off = 0;
  for (const m of metrics) {
    const v = voteOf(m);
    if (v === "risk-on") on += 1;
    if (v === "risk-off") off += 1;
  }
  return on > off ? "risk-on" : off > on ? "risk-off" : "mixed";
}

const STANCE_NQ_LABEL: Record<InterpretStance, string> = {
  "risk-on": "supports NQ",
  "risk-off": "pressures NQ",
  mixed: "neutral for NQ",
};

/** deterministic combination read for one family: its top 2 signals */
function familyReadParts(metrics: InterpretMetricValue[], famId: MetricFamily): InterpretMetricValue[] {
  const prio = FAMILY_PRIORITY[famId] ?? [];
  const rank = (id: string) => (prio.indexOf(id) === -1 ? 99 : prio.indexOf(id));
  const picks = [...metrics]
    .filter((m) => m.direction === "up" || m.direction === "down")
    .sort((a, b) => rank(a.id) - rank(b.id))
    .slice(0, 2);
  return picks.length > 0 ? picks : [...metrics].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 2);
}

/* ---------------------------------------------------------------- *
 * deterministic news reads
 * ---------------------------------------------------------------- */

/** "0.2%", "195K", "-3.1" → number (unit-agnostic; same-format pairs) */
function newsNum(v: string | null): number | null {
  if (v == null || v === "" || v === "—") return null;
  const m = /-?[\d.,]+/.exec(v);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function newsExplainOf(it: InterpretNewsItem): string {
  return newsGuideFor(it.title).what;
}

/** when the event has released WITH an actual, judge it against the
 *  forecast using the catalog's direction; otherwise give the
 *  conditional pre-release read */
export function newsNqImpactOf(it: InterpretNewsItem): string {
  const g = newsGuideFor(it.title);
  if (it.released && it.actual) {
    const a = newsNum(it.actual);
    const f = newsNum(it.forecast);
    const p = it.previous ? ` (prev ${it.previous})` : "";
    if (a != null && f != null && g.goodWhen) {
      const diff = Math.round((a - f) * 100) / 100;
      const eps = 0.05;
      const good = g.goodWhen === "lower" ? diff <= -eps : diff >= eps;
      const bad = g.goodWhen === "lower" ? diff >= eps : diff <= -eps;
      if (good) return `actual ${it.actual} vs ${it.forecast} f${p} — ${g.goodForNq}`;
      if (bad) return `actual ${it.actual} vs ${it.forecast} f${p} — ${g.badForNq}`;
    }
    return `actual ${it.actual} vs ${it.forecast} f${p} — in line, no repricing pressure`;
  }
  return `before release — good: ${g.goodForNq} · bad: ${g.badForNq}`;
}

export function renderDeterministicInterpret(s: InterpretSnapshot): InterpretContent {
  const metrics: InterpretMetricRead[] = s.metrics.map((m) => ({
    id: m.id,
    explain: metricExplainOf(m),
    nqImpact: metricNqImpactOf(m),
  }));
  const news: InterpretNewsRead[] = s.news.map((it) => ({
    id: it.id,
    explain: newsExplainOf(it),
    nqImpact: newsNqImpactOf(it),
  }));
  const byFamily = new Map<MetricFamily, InterpretMetricValue[]>();
  for (const m of s.metrics) {
    const arr = byFamily.get(m.family) ?? [];
    arr.push(m);
    byFamily.set(m.family, arr);
  }
  const families: InterpretFamilyRead[] = FAMILIES.map((f) => {
    const fam = byFamily.get(f.id) ?? [];
    const top = familyReadParts(fam, f.id);
    return {
      id: f.id,
      stance: familyStanceOf(fam),
      explain: top.map((m) => metricExplainOf(m)).join(" · "),
      nqImpact: `${STANCE_NQ_LABEL[familyStanceOf(fam)]} · ${top.map((m) => `${m.label} ${m.value}`).join(" · ")}`,
    };
  });

  /* ---- combined: majority of the family stances, tape first ---- */
  let on = 0;
  let off = 0;
  for (const f of families) {
    if (f.stance === "risk-on") on += 1;
    if (f.stance === "risk-off") off += 1;
  }
  const stance: InterpretStance = on > off ? "risk-on" : off > on ? "risk-off" : "mixed";

  const prio = (id: string, fam: MetricFamily) => {
    const p = FAMILY_PRIORITY[fam] ?? [];
    const i = p.indexOf(id);
    return i === -1 ? 99 : i;
  };
  const strong = s.metrics
    .filter((m) => m.direction === "up" || m.direction === "down")
    .sort((a, b) => {
      const va = voteOf(a) ? 0 : 1;
      const vb = voteOf(b) ? 0 : 1;
      return va - vb || prio(a.id, a.family) - prio(b.id, b.family);
    })
    .slice(0, 2);
  const sig = strong.map((m) => `${m.label} ${m.value}`).join(" · ");

  /* ---- the tape line (the retired briefing's bottom line) ---- */
  const t = s.tape;
  const tapeParts: string[] = [];
  if (t.changePct != null) tapeParts.push(`NQ ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%`);
  if (t.closePosPct != null) tapeParts.push(`close ${t.closePosPct.toFixed(0)}% of range`);
  if (t.cumulativeDelta != null) tapeParts.push(`Δ ${t.cumulativeDelta >= 0 ? "+" : ""}${(t.cumulativeDelta / 1000).toFixed(1)}k`);
  if (t.realizedBandPct != null) tapeParts.push(`1σ ±${t.realizedBandPct.toFixed(2)}%`);
  const tapeLine = tapeParts.length > 0 ? `tape: ${tapeParts.join(" · ")}` : null;

  const headline = `${stance.toUpperCase()}${tapeParts.length > 0 ? ` · NQ ${t.changePct != null ? `${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%` : ""}` : ""}${sig ? ` · ${sig}` : ""}`.replace(/\s+/g, " ").trim();

  const read: string[] = [];
  if (tapeLine) read.push(tapeLine);
  for (const f of families.filter((x) => x.stance !== "mixed").slice(0, 3)) {
    const def = FAMILIES.find((x) => x.id === f.id);
    read.push(`${def?.label ?? f.id}: ${f.explain}`);
  }
  if (read.length <= 1) read.push("no family carries a directional vote — the tape decides");

  const caveats: string[] = [];
  if (s.staleness.bonds) caveats.push("treasury curve stale");
  if (s.staleness.news) caveats.push("news calendar stale");
  if (s.staleness.earnings) caveats.push("earnings feed stale");
  if (s.errors.length > 0) caveats.push(`watch errors: ${s.errors.length}`);
  if (caveats.length === 0) caveats.push("all sources fresh");

  return { combined: { headline, stance, read, caveats }, families, metrics, news };
}

/* ---------------------------------------------------------------- *
 * DeepSeek JSON-mode payload
 * ---------------------------------------------------------------- */

export const INTERPRET_SCHEMA_EXAMPLE = {
  combined: {
    headline: "EXAMPLE — one line: the cross-family stance + the main driver",
    stance: "mixed",
    read: ["EXAMPLE — tape first, then one bullet per dominant theme, ≤20 words, numbers from the snapshot"],
    caveats: ["EXAMPLE — 'CNBC quotes ~20 min delayed'"],
  },
  families: [{ id: "risk", explain: "EXAMPLE — what this family's metrics say TOGETHER, one line", nqImpact: "EXAMPLE — the implication for reading NQ, one line" }],
  metrics: [{ id: "vix.level", explain: "EXAMPLE — what TODAY's value + direction implies, one line", nqImpact: "EXAMPLE — what that means for the NQ tape, one line" }],
  news: [{ id: "2026-10-14|08:30|Core CPI m/m", explain: "EXAMPLE — what the release measures", nqImpact: "EXAMPLE — what the result (or the setup ahead of it) means for NQ" }],
};

const SYSTEM_PROMPT = [
  "You are the macro interpreter for a personal NQ (Nasdaq-100 futures) scalping dashboard.",
  "A scalper reads your output BETWEEN TICKS: maximum density, minimum words.",
  "",
  "You receive ONE JSON snapshot: (1) the current NQ session TAPE (change, position in range,",
  "cumulative delta, realized 1σ), (2) every macro metric the dashboard tracks, grouped into 8",
  "families (risk & vol, rates, fx & equities, commodities, crypto, liquidity & positioning,",
  "calendar & events, structure), each with its value, a computed direction and the dashboard's",
  "plain-language up/down guide, and (3) this week's US economic calendar with forecast/previous/",
  "actual where available.",
  "",
  "Every read you write has TWO parts:",
  "  explain  — what the current value/state MEANS (one line, ≤16 words)",
  "  nqImpact — the IMPACT ON READING NQ: what it implies for the NQ tape and how to trade it",
  "             today (one line, ≤18 words). This is mandatory for every metric, family, news",
  "             item and the combined read.",
  "",
  "You produce FOUR layers:",
  "1. metrics[] — one entry per metric id in the snapshot: explain + nqImpact. For",
  "non-directional metrics (calendar, regime), interpret the proximity/state. Say 'unavailable'",
  "if the value is null/—.",
  "2. families[] — one entry per family id: the COMBINATION of that family's metrics — how they",
  "reinforce or contradict each other (explain, ≤22 words) and the resulting NQ impact (≤18 words).",
  "3. news[] — one entry per calendar event: explain what the release measures (from the",
  "catalog's what field, condensed). For nqImpact: if released WITH an actual, judge the result",
  "against forecast/previous and say what it means for NQ; if upcoming, say what result NQ needs",
  "to see (beat/miss implication).",
  "4. combined — the complete read: the TAPE FIRST (change, range position, delta, 1σ — like the",
  "old pre-open briefing: up/down/chop bias from the tape, then the macro), then stance",
  "risk-on | risk-off | mixed, a headline ≤15 words, ≤4 read bullets (≤22 words each), and ≤2",
  "caveats (data vintages only: delayed/stale/unavailable).",
  "",
  "Rules:",
  "1. Every number must come from the snapshot; null means unavailable — say so, never invent.",
  "2. VINTAGES: daily prints (curve, VIX stats, FRED, COT, HTF) are NOT intraday; CNBC quotes",
  "are ~20 min delayed; BTC is Coinbase real-time when labeled so. State the vintage when it",
  "changes the meaning.",
  "3. Contradictions are information: say them plainly (e.g. 'equities bid while HY widens').",
  "4. DISPLAY-ONLY context for the human trader; it never feeds a signal engine. Analysis of",
  "the situation only — no trade instructions, orders, or disclaimers.",
  "5. JSON GRAMMAR (strict): every string must be a SINGLE line — never a literal newline",
  "inside a string value. Emit ONLY the JSON object, nothing else.",
  "6. The example shows SHAPE ONLY — its words are placeholders. Never reuse an example",
  "sentence, and never invent metric/news ids: copy them from the snapshot.",
].join("\n");

export function buildInterpretPayload(
  snapshot: InterpretSnapshot,
  model: string,
): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format: { type: string };
  thinking: { type: string };
  max_tokens: number;
} {
  const metrics = snapshot.metrics.map((m) => {
    const g = guideFor(m.id);
    return {
      id: m.id,
      label: m.label,
      family: m.family,
      value: m.value,
      direction: m.direction,
      num: m.num,
      delta: m.delta,
      what: g?.what ?? null,
      upMeans: g?.up ?? null,
      downMeans: g?.down ?? null,
      readHint: g?.read ?? null,
      nqImpactHint: g?.nqImpact ?? null,
    };
  });
  const news = snapshot.news.map((it) => {
    const g = newsGuideFor(it.title);
    return {
      ...it,
      whatHint: g.what,
      goodForNq: g.goodForNq,
      badForNq: g.badForNq,
    };
  });
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          task: "Produce the daily macro interpretation: per-metric, per-family, per-news-event and the combined cross-family read — each with an explain and an NQ impact.",
          exampleJsonOutput: INTERPRET_SCHEMA_EXAMPLE,
          families: FAMILIES.map((f) => ({ id: f.id, label: f.label, blurb: f.blurb })),
          snapshot: {
            generatedAt: snapshot.generatedAt,
            etDay: snapshot.etDay,
            etClock: snapshot.etClock,
            tape: snapshot.tape,
            staleness: snapshot.staleness,
            errors: snapshot.errors,
            metrics,
            news,
          },
        }),
      },
    ],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    max_tokens: 8000,
  };
}

/* ---------------------------------------------------------------- *
 * response parsing + merge
 * ---------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v : fallback);

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** extract the first ```json … ``` fence, if any */
function fencedJson(raw: string): string | null {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return m ? m[1] : null;
}

/** slice from the first { to the last } and escape literal newlines /
 *  tabs that sit inside string values (the common LLM JSON crime) */
function repairJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return raw;
  const s = raw.slice(start, end + 1);
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\t" ? "\\t" : "\\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** two-part read: explain + nqImpact, tolerant of a legacy `read` */
function twoPart(o: Record<string, unknown>, fallback: { explain: string; nqImpact: string }): { explain: string; nqImpact: string } {
  return {
    explain: str(o.explain, str(o.read, fallback.explain)),
    nqImpact: str(o.nqImpact, fallback.nqImpact),
  };
}

export type ParsedInterpret = {
  combined: Partial<InterpretCombined> | null;
  families: Array<{ id: MetricFamily; explain: string; nqImpact: string }>;
  metrics: Array<{ id: string; explain: string; nqImpact: string }>;
  news: Array<{ id: string; explain: string; nqImpact: string }>;
};

/** tolerant parser — returns null when the response is unusable, and
 *  drops unknown ids instead of letting them through */
export function parseInterpretContent(raw: string | null | undefined): ParsedInterpret | null {
  if (!raw) return null;
  const candidates = [raw, repairJson(raw), fencedJson(raw)];
  let j: unknown = null;
  for (const c of candidates) {
    if (!c) continue;
    try {
      j = JSON.parse(c);
      break;
    } catch {
      try {
        j = JSON.parse(repairJson(c));
        break;
      } catch {
        /* next candidate */
      }
    }
  }
  if (!isObj(j)) return null;

  const knownFamilies = new Set(FAMILIES.map((f) => f.id));

  const combinedRaw = isObj(j.combined) ? j.combined : null;
  const combined: ParsedInterpret["combined"] = combinedRaw
    ? {
        headline: typeof combinedRaw.headline === "string" ? combinedRaw.headline : undefined,
        stance: isStance(combinedRaw.stance) ? combinedRaw.stance : undefined,
        read: Array.isArray(combinedRaw.read) ? strArr(combinedRaw.read) : undefined,
        caveats: Array.isArray(combinedRaw.caveats) ? strArr(combinedRaw.caveats) : undefined,
      }
    : null;

  const families: ParsedInterpret["families"] = [];
  if (Array.isArray(j.families)) {
    for (const f of j.families) {
      if (!isObj(f) || typeof f.id !== "string" || !knownFamilies.has(f.id as MetricFamily)) continue;
      const read = twoPart(f, { explain: "", nqImpact: "" });
      if (read.explain || read.nqImpact) families.push({ id: f.id as MetricFamily, ...read });
    }
  }

  const pick = (arr: unknown): ParsedInterpret["metrics"] => {
    const out: ParsedInterpret["metrics"] = [];
    if (Array.isArray(arr)) {
      for (const m of arr) {
        if (!isObj(m) || typeof m.id !== "string") continue;
        const read = twoPart(m, { explain: "", nqImpact: "" });
        if (read.explain || read.nqImpact) out.push({ id: m.id, ...read });
      }
    }
    return out;
  };
  const metrics = pick(j.metrics);
  const news = pick(j.news);

  /* nothing usable → null (caller falls back to deterministic) */
  if (!combined && families.length === 0 && metrics.length === 0 && news.length === 0) return null;
  return { combined, families, metrics, news };
}

/** LLM wins wherever it produced a valid entry for a KNOWN id; the
 *  deterministic renderer fills everything else, so the tab is never
 *  half-blank. Unknown ids are dropped. */
export function mergeInterpretContent(parsed: ParsedInterpret | null, det: InterpretContent, snapshot: InterpretSnapshot): InterpretContent {
  const detFamilies = new Map(det.families.map((f) => [f.id, f]));
  const detMetrics = new Map(det.metrics.map((m) => [m.id, m]));
  const detNews = new Map(det.news.map((n) => [n.id, n]));

  let combined = det.combined;
  if (parsed?.combined) {
    const p = parsed.combined;
    combined = {
      headline: str(p.headline, det.combined.headline),
      stance: isStance(p.stance) ? p.stance : det.combined.stance,
      read: p.read && p.read.length > 0 ? p.read : det.combined.read,
      caveats: p.caveats && p.caveats.length > 0 ? p.caveats : det.combined.caveats,
    };
  }

  const families: InterpretFamilyRead[] = FAMILIES.map((f) => {
    const detF = detFamilies.get(f.id);
    const parsedF = parsed?.families.find((x) => x.id === f.id);
    return {
      id: f.id,
      stance: detF?.stance ?? "mixed",
      explain: parsedF?.explain || detF?.explain || "no read",
      nqImpact: parsedF?.nqImpact || detF?.nqImpact || "no read",
    };
  });

  const metrics: InterpretMetricRead[] = snapshot.metrics.map((m) => {
    const detM = detMetrics.get(m.id);
    const parsedM = parsed?.metrics.find((x) => x.id === m.id);
    return {
      id: m.id,
      explain: parsedM?.explain || detM?.explain || "no read",
      nqImpact: parsedM?.nqImpact || detM?.nqImpact || "no read",
    };
  });

  const news: InterpretNewsRead[] = snapshot.news.map((n) => {
    const detN = detNews.get(n.id);
    const parsedN = parsed?.news.find((x) => x.id === n.id);
    return {
      id: n.id,
      explain: parsedN?.explain || detN?.explain || "no read",
      nqImpact: parsedN?.nqImpact || detN?.nqImpact || "no read",
    };
  });

  return { combined, families, metrics, news };
}
