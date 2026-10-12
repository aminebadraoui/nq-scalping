/* ------------------------------------------------------------------ *
 * Interpretation text — PURE module for the Macro tab's AI
 * interpretation layer (per-metric reads, per-family combination reads,
 * the combined all-families read).
 *
 * Everything here is a pure function over plain data: the DeepSeek
 * prompt/payload builder, the JSON-mode response parser, the merge
 * (LLM wins where it produced a valid entry, the deterministic
 * renderer fills the rest), and the deterministic fallback itself.
 * No feeds, no DB, no side effects — offline-testable.
 *
 * The orchestration (snapshot assembly, persistence) lives in
 * lib/macroInterpret.ts, which imports this module. The static
 * up/down guides live in lib/macroGuide.ts.
 * DISPLAY-ONLY — the signal engine never imports either module.
 * ------------------------------------------------------------------ */

import { FAMILIES, guideFor, type MetricFamily, type MetricGuide } from "./macroGuide";

export type InterpretDirection = "up" | "down" | "flat" | null;

export type InterpretStance = "risk-on" | "risk-off" | "mixed";

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
  metrics: InterpretMetricValue[];
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

export type InterpretFamilyRead = { id: MetricFamily; stance: InterpretStance; read: string };

export type InterpretMetricRead = { id: string; read: string };

export type InterpretContent = {
  combined: InterpretCombined;
  families: InterpretFamilyRead[];
  metrics: InterpretMetricRead[];
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

/** deterministic one-line read for a metric: value + the applicable guide */
export function metricReadOf(m: InterpretMetricValue): string {
  const g = guideFor(m.id);
  if (!g) return `${m.value} — no guide`;
  const line = applicableGuideLine(g, m.direction);
  const dir = m.direction ? `${DIR_ARROW[m.direction]} ` : "";
  return `${dir}${m.value} — ${line}`;
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

/** deterministic combination read for one family: its top 2 signals */
export function familyReadOf(metrics: InterpretMetricValue[], famId: MetricFamily): string {
  const prio = FAMILY_PRIORITY[famId] ?? [];
  const rank = (id: string) => (prio.indexOf(id) === -1 ? 99 : prio.indexOf(id));
  const picks = [...metrics]
    .filter((m) => m.direction === "up" || m.direction === "down")
    .sort((a, b) => rank(a.id) - rank(b.id))
    .slice(0, 2);
  const source = picks.length > 0 ? picks : [...metrics].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 2);
  return source.map((m) => metricReadOf(m)).join(" · ");
}

export function renderDeterministicInterpret(s: InterpretSnapshot): InterpretContent {
  const metrics: InterpretMetricRead[] = s.metrics.map((m) => ({ id: m.id, read: metricReadOf(m) }));
  const byFamily = new Map<MetricFamily, InterpretMetricValue[]>();
  for (const m of s.metrics) {
    const arr = byFamily.get(m.family) ?? [];
    arr.push(m);
    byFamily.set(m.family, arr);
  }
  const families: InterpretFamilyRead[] = FAMILIES.map((f) => {
    const fam = byFamily.get(f.id) ?? [];
    return { id: f.id, stance: familyStanceOf(fam), read: familyReadOf(fam, f.id) };
  });

  /* ---- combined: majority of the family stances ---- */
  let on = 0;
  let off = 0;
  for (const f of families) {
    if (f.stance === "risk-on") on += 1;
    if (f.stance === "risk-off") off += 1;
  }
  const stance: InterpretStance = on > off ? "risk-on" : off > on ? "risk-off" : "mixed";

  /* headline: stance + the two strongest directional signals overall */
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
  const headline = `${stance.toUpperCase()}${sig ? ` · ${sig}` : ""}`;

  const read = families
    .filter((f) => f.stance !== "mixed")
    .slice(0, 4)
    .map((f) => {
      const def = FAMILIES.find((x) => x.id === f.id);
      return `${def?.label ?? f.id}: ${f.read}`;
    });
  if (read.length === 0) read.push("no family carries a directional vote — the tape decides");

  const caveats: string[] = [];
  if (s.staleness.bonds) caveats.push("treasury curve stale");
  if (s.staleness.news) caveats.push("news calendar stale");
  if (s.staleness.earnings) caveats.push("earnings feed stale");
  if (s.errors.length > 0) caveats.push(`watch errors: ${s.errors.length}`);
  if (caveats.length === 0) caveats.push("all sources fresh");

  return { combined: { headline, stance, read, caveats }, families, metrics };
}

/* ---------------------------------------------------------------- *
 * DeepSeek JSON-mode payload
 * ---------------------------------------------------------------- */

export const INTERPRET_SCHEMA_EXAMPLE = {
  combined: {
    headline: "EXAMPLE — one line: the cross-family stance + the main driver",
    stance: "mixed",
    read: ["EXAMPLE — one bullet per dominant theme, ≤20 words, numbers from the snapshot"],
    caveats: ["EXAMPLE — 'CNBC quotes ~20 min delayed'"],
  },
  families: [{ id: "risk", read: "EXAMPLE — what this family's metrics say TOGETHER, one line" }],
  metrics: [{ id: "vix.level", read: "EXAMPLE — what TODAY's value + direction implies, one line" }],
};

const SYSTEM_PROMPT = [
  "You are the macro interpreter for a personal NQ (Nasdaq-100 futures) scalping dashboard.",
  "A scalper reads your output BETWEEN TICKS: maximum density, minimum words.",
  "",
  "You receive ONE JSON snapshot: every macro metric the dashboard tracks, grouped into 8",
  "families (risk & vol, rates, fx & equities, commodities, crypto, liquidity & positioning,",
  "calendar & events, structure). Each metric carries its current value, a computed direction",
  "(up/down/flat; null = non-directional), and the dashboard's plain-language guide of what",
  "up and down MEAN for that metric.",
  "",
  "You produce THREE layers:",
  "1. metrics[] — one entry per metric id in the snapshot: what TODAY's value + direction",
  "implies for the NQ session, one line, ≤16 words. For non-directional metrics (calendar,",
  "regime), interpret the proximity/state. Say 'unavailable' if the value is null/—.",
  "2. families[] — one entry per family id: the COMBINATION of that family's metrics — how",
  "they reinforce or contradict each other, one line, ≤22 words.",
  "3. combined — the complete read across ALL families: stance risk-on | risk-off | mixed,",
  "a headline ≤15 words, ≤3 read bullets (each ≤22 words) naming the dominant cross-family",
  "themes (e.g. risk-on equities + calm VIX + steepening curve), and ≤2 caveats (data",
  "vintages only: delayed/stale/unavailable).",
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
  "sentence, and never invent metric ids: copy them from the snapshot.",
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
    };
  });
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          task: "Produce the daily macro interpretation: per-metric reads, per-family combination reads, and the combined cross-family read.",
          exampleJsonOutput: INTERPRET_SCHEMA_EXAMPLE,
          families: FAMILIES.map((f) => ({ id: f.id, label: f.label, blurb: f.blurb })),
          snapshot: {
            generatedAt: snapshot.generatedAt,
            etDay: snapshot.etDay,
            etClock: snapshot.etClock,
            staleness: snapshot.staleness,
            errors: snapshot.errors,
            metrics,
          },
        }),
      },
    ],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    max_tokens: 6000,
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

export type ParsedInterpret = {
  combined: Partial<InterpretCombined> | null;
  families: Array<{ id: MetricFamily; read: string }>;
  metrics: Array<{ id: string; read: string }>;
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
      const read = str(f.read, "");
      if (read) families.push({ id: f.id as MetricFamily, read });
    }
  }

  const metrics: ParsedInterpret["metrics"] = [];
  if (Array.isArray(j.metrics)) {
    for (const m of j.metrics) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      const read = str(m.read, "");
      if (read) metrics.push({ id: m.id, read });
    }
  }

  /* nothing usable → null (caller falls back to deterministic) */
  if (!combined && families.length === 0 && metrics.length === 0) return null;
  return { combined, families, metrics };
}

/** LLM wins wherever it produced a valid entry for a KNOWN id; the
 *  deterministic renderer fills everything else, so the card is never
 *  half-blank. Unknown ids are dropped. */
export function mergeInterpretContent(parsed: ParsedInterpret | null, det: InterpretContent, snapshot: InterpretSnapshot): InterpretContent {
  const detCombined = det.combined;
  const detFamilies = new Map(det.families.map((f) => [f.id, f]));
  const detMetrics = new Map(det.metrics.map((m) => [m.id, m]));

  let combined = detCombined;
  if (parsed?.combined) {
    const p = parsed.combined;
    combined = {
      headline: str(p.headline, detCombined.headline),
      stance: isStance(p.stance) ? p.stance : detCombined.stance,
      read: p.read && p.read.length > 0 ? p.read : detCombined.read,
      caveats: p.caveats && p.caveats.length > 0 ? p.caveats : detCombined.caveats,
    };
  }

  const families: InterpretFamilyRead[] = FAMILIES.map((f) => {
    const detF = detFamilies.get(f.id);
    const parsedF = parsed?.families.find((x) => x.id === f.id);
    return {
      id: f.id,
      stance: detF?.stance ?? "mixed",
      read: parsedF?.read || detF?.read || "no read",
    };
  });

  const metrics: InterpretMetricRead[] = snapshot.metrics.map((m) => {
    const detM = detMetrics.get(m.id);
    const parsedM = parsed?.metrics.find((x) => x.id === m.id);
    return { id: m.id, read: parsedM?.read || detM?.read || "no read" };
  });

  return { combined, families, metrics };
}
