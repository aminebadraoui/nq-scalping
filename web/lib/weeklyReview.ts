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

/** Phase 4 — per-study runtime budgets (minutes, advisory alarms; the
 *  hard kill stays the 60-min subprocess timeout). Derived from the
 *  first measured VPS warm-cache run (2026-10-17, ~7 min total):
 *  countFrac ~4 min · sideVeto ~3 min — budgets sit ~5× above that so a
 *  cold cache or a code regression is what trips them. */
export const DEFAULT_STUDY_BUDGETS: Record<string, number> = {
  countFracGateStudy: 20,
  sideVetoStudy: 15,
  hourExpectancyStudy: 15,
};

/** Merge WEEKLY_BUDGET_MIN ("name=min,name=min") over the defaults.
 *  Invalid entries are ignored — never throws. */
export function parseBudgetEnv(env: string): Record<string, number> {
  const out = { ...DEFAULT_STUDY_BUDGETS };
  for (const kv of env.split(",")) {
    const [k, v] = kv.split("=");
    const name = (k ?? "").trim();
    const n = Number(v);
    if (name && Number.isFinite(n) && n > 0 && n <= 60) out[name] = n;
  }
  return out;
}

/** budget in minutes for a study script path ("scripts/x.ts" → basename). */
export function budgetFor(budgets: Record<string, number>, script: string): number | null {
  const base = script.split("/").pop() ?? "";
  const name = base.endsWith(".ts") ? base.slice(0, -3) : base;
  return budgets[name] ?? null;
}

/* ---------------- per-account rollup (2026-10-17) ---------------- */

export type AccountRollup = {
  account: string;
  matched: {
    n: number;
    wins: number;
    losses: number;
    grossUsd: number;
    commissions: number;
    netUsd: number;
  };
  manual: { fills: number; grossUsd: number };
  realizedUsd: number | null;
  netLiq: number | null;
};

type TradeLike = { account?: string; result?: string; grossUsd?: number; commissions?: number; netUsd?: number };
type RunLike = {
  account?: string;
  window_start?: unknown;
  window_end?: unknown;
  manual_fills?: unknown;
  manual_gross_usd?: unknown;
  account_net?: unknown;
  account_realized?: unknown;
};

const numOr = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Merge the week's matched trades and reconcile_runs into one row per
 * account. Reconcile runs are deduped by (window, account) keeping the
 * FIRST run of each window; `realizedUsd` is the max account-reported
 * realized P&L for the week (the post-reset re-run reports 0 — the max
 * preserves the number the broker portal showed). Pure — unit-tested.
 */
export function buildAccountRollup(trades: TradeLike[], runs: RunLike[]): AccountRollup[] {
  const byAccount = new Map<string, { matched: AccountRollup["matched"]; manual: AccountRollup["manual"]; realizedUsd: number | null; netLiq: number | null }>();

  const bucket = (account: string) => {
    const a = byAccount.get(account) ??
      (byAccount.set(account, {
        matched: { n: 0, wins: 0, losses: 0, grossUsd: 0, commissions: 0, netUsd: 0 },
        manual: { fills: 0, grossUsd: 0 },
        realizedUsd: null,
        netLiq: null,
      }).get(account)!);
    return a;
  };

  for (const t of trades) {
    const account = (t.account ?? "").trim() || "unknown";
    const b = bucket(account);
    const m = b.matched;
    m.n += 1;
    const result = String(t.result ?? "");
    if (result === "win") m.wins += 1;
    if (result === "loss") m.losses += 1;
    m.grossUsd += numOr(t.grossUsd);
    m.commissions += numOr(t.commissions);
    m.netUsd += numOr(t.netUsd);
  }

  // dedupe runs: same (window_start, window_end, account) twice a night —
  // keep the FIRST run of each window (the later one ran post-reset and
  // reports a zeroed snapshot). Keyed at DATE level: the two nightly runs
  // can carry slightly different timestamps for the same calendar window.
  const seen = new Set<string>();
  const runsLatest: RunLike[] = [];
  for (const r of runs) {
    const key = `${String(r.window_start).slice(0, 10)}|${String(r.window_end).slice(0, 10)}|${(r.account ?? "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runsLatest.push(r);
  }

  for (const r of runsLatest) {
    const account = (r.account ?? "").trim() || "unknown";
    const b = bucket(account);
    b.manual.fills += numOr(r.manual_fills);
    b.manual.grossUsd += numOr(r.manual_gross_usd);
    const realized = r.account_realized === null || r.account_realized === undefined ? null : numOr(r.account_realized);
    if (realized !== null && (b.realizedUsd === null || realized > b.realizedUsd)) b.realizedUsd = realized;
    const netLiq = r.account_net === null || r.account_net === undefined ? null : numOr(r.account_net);
    if (netLiq !== null) b.netLiq = netLiq;
  }

  return [...byAccount.entries()]
    .map(([account, b]) => ({ account, ...b }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

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
