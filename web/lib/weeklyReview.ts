/* ------------------------------------------------------------------ *
 * Weekly-review experiment helpers — the next-week hypothesis loop.
 *
 * The Saturday job's LLM narrative doubles as a structured hypothesis
 * source: the model answers with JSON { narrative, hypotheses } where
 * each hypothesis proposes ONE experiment against the frozen production
 * stack (RESEARCH-LOOP rule 1). The hypotheses land as
 * `weekly_experiments` rows (status 'proposed'); the user queues the
 * ones they want on /review; the NEXT Saturday job runs the queued set
 * in place of the default study queue.
 *
 * Everything here is pure and unit-tested. Safety by construction:
 *   · a hypothesis may only name a study in STUDY_CATALOG;
 *   · args are sanitized — no --report-json/--apply/--now/--dump/--warm,
 *     no newlines, bounded count and length (execFile passes argv
 *     directly, so there is no shell to inject into);
 *   · studies without a --report-json emitter run as research-only
 *     (recorded, never promoted) — the promotion contract remains the
 *     only path into strategy_overrides.
 * ------------------------------------------------------------------ */

export type Hypothesis = {
  title: string;
  study: string; // e.g. "scripts/countFracGateStudy.ts"
  args: string[]; // safe CLI args (the job appends --report-json itself)
  rationale: string;
};

export type ExperimentVerdict = "passed" | "rejected" | "error" | "research";

export type ExperimentRow = {
  id: number;
  created_at: string;
  week_start: string;
  title: string;
  study: string;
  args: string[];
  rationale: string;
  status: "proposed" | "queued" | "ran" | "skipped";
  source: string;
  ran_at: string | null;
  result: { verdict: ExperimentVerdict; reasons: string[]; exit: number | null } | null;
};

/** the catalog the LLM may propose experiments from. `promotes` marks
 *  studies whose --report-json feeds the promotion contract; the rest
 *  run research-only (recorded, never promoted). */
export const STUDY_CATALOG: Array<{ study: string; gates: string; flags: string; promotes: boolean }> = [
  {
    study: "scripts/countFracGateStudy.ts",
    gates: "min_count_frac",
    flags: "--offline [--family momentum_expansion|momentum_flush] [--theta 0.55|0.60|0.65|0.70|0.75]",
    promotes: true,
  },
  {
    study: "scripts/sideVetoStudy.ts",
    gates: "side_veto",
    flags: "--offline --family momentum_expansion --veto '{\"side\":\"long|short\",\"hours\":[8..16]}'",
    promotes: true,
  },
  {
    study: "scripts/hourExpectancyStudy.ts",
    gates: "research only — hour-expectancy cells per family",
    flags: "--offline",
    promotes: false,
  },
];

const CATALOG_BY_STUDY = new Map(STUDY_CATALOG.map((c) => [c.study, c]));

/** flags a hypothesis may never carry (the job manages these itself) */
const FORBIDDEN_ARG_PREFIXES = ["--report-json", "--apply", "--now", "--dump", "--warm", "--sweep-out"];
const MAX_ARGS = 10;
const MAX_ARG_LEN = 120;

/** Validate + sanitize one LLM hypothesis. Returns null when it is not
 *  safe to run — every rule fails closed. */
export function sanitizeHypothesis(raw: unknown): Hypothesis | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const title = o.title;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 140) return null;

  const study = o.study;
  if (typeof study !== "string" || !CATALOG_BY_STUDY.has(study)) return null;

  const rawArgs = o.args;
  let args: string[] = [];
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs)) return null;
    if (rawArgs.length > MAX_ARGS) return null;
    for (const a of rawArgs) {
      if (typeof a !== "string") return null;
      if (a.length === 0 || a.length > MAX_ARG_LEN) return null;
      if (/[\n\r]/.test(a)) return null;
      if (FORBIDDEN_ARG_PREFIXES.some((p) => a.startsWith(p))) return null;
      args.push(a);
    }
  }

  const rationale = o.rationale;
  if (rationale !== undefined && typeof rationale !== "string") return null;

  return { title: title.trim(), study, args, rationale: (rationale ?? "").slice(0, 500) };
}

/**
 * Parse the LLM response. Accepts:
 *   · plain prose → { narrative: text, hypotheses: [] }
 *   · a JSON object { narrative, hypotheses } (optionally inside
 *     ```json fences) → narrative from the field (prose fallback) +
 *     sanitized hypotheses (invalid entries dropped).
 * Never throws.
 */
export function parseLlmPayload(text: string): { narrative: string; hypotheses: Hypothesis[] } {
  const prose = { narrative: text, hypotheses: [] as Hypothesis[] };

  let candidates: string[] = [];
  candidates.push(text.trim());
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  // also try the outermost { … } span — DeepSeek sometimes prefixes prose
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1).trim());

  for (const c of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(c);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    const narrative = typeof o.narrative === "string" && o.narrative.trim().length > 0 ? o.narrative.trim() : text;
    if (!Array.isArray(o.hypotheses)) return { narrative, hypotheses: [] };
    const hypotheses: Hypothesis[] = [];
    for (const h of o.hypotheses) {
      const clean = sanitizeHypothesis(h);
      if (clean) hypotheses.push(clean);
    }
    return { narrative, hypotheses };
  }

  return prose;
}

/** The system-prompt fragment describing the study catalog to the LLM. */
export function catalogPromptText(): string {
  return STUDY_CATALOG.map(
    (c) =>
      `- ${c.study} (${c.gates}, ${c.promotes ? "promotion-contract capable" : "research only"}): ${c.flags}`,
  ).join("\n");
}
