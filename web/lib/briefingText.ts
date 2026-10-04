/* ------------------------------------------------------------------ *
 * Briefing text — PURE module for the AI macro briefing card.
 *
 * Everything here is a pure function over plain data: the DeepSeek
 * prompt/payload builder, the JSON-mode response parser, the schema
 * example, and the deterministic fallback renderer used when the LLM
 * is not configured or fails. No imports of the feed layer, no DB, no
 * side effects — so the offline test suite can cover it directly.
 *
 * The orchestration (snapshot assembly, feed fetches, persistence)
 * lives in lib/macroBriefing.ts, which imports this module.
 * ------------------------------------------------------------------ */

export type BriefingKind =
  | "evening-open"
  | "pre-open"
  | "post-open"
  | "mid-morning"
  | "midday"
  | "pre-close"
  | "post-close"
  | "on-demand";

export type BriefingSource = "llm" | "deterministic";

/** a horizontal line the chart can draw: briefing level → NQ price */
export type ChartLine = { label: string; price: number; color: string };

/** numeric twin of SnapshotLevel — what the chart consumes */
export type SnapshotLine = { label: string; price: number; tone?: string };

/** the structured output the card renders. The user's spec, verbatim:
 *  (1) is the bias UP / DOWN / CHOP, (2) what would change it.
 *  Key LEVELS are rendered by the card directly from the stored
 *  snapshot (snapshot.nq.levels — GEX walls/flip pre-converted to NQ
 *  prices in code), so the model only references them in watchFors. */
export type BriefingContent = {
  /** one-line bottom line, ≤15 words, conditional on the watch-fors */
  headline: string;
  /** up | down | chop */
  bias: string;
  /** compressed | normal | elevated | extreme */
  vol: string;
  /** the why behind the bias: ≤2 bullets, each ≤18 words */
  read: string[];
  /** conditions that would change the bias: ≤3, each with a price */
  watchFors: string[];
  /** data caveats only (vintages/staleness): ≤2, each ≤10 words */
  caveats: string[];
};

/* ---------------------------------------------------------------- *
 * snapshot shape — what the orchestrator hands to the prompt builder
 * ---------------------------------------------------------------- */

export type SnapshotQuote = { symbol: string; label: string; value: number | null; changePct: number | null };

export type SnapshotNewsItem = {
  day: string;
  timeET: string;
  title: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
  released: boolean;
};

export type SnapshotEarningsItem = {
  symbol: string;
  nextDate: string | null;
  nextTime: string | null;
  nextEpsEst: number | null;
  nextEstimated: boolean;
};

export type SnapshotLevel = { label: string; value: string; note: string };

/** code-decided bias + vol with the evidence that produced them —
 *  the model must use these verbatim (no bias flip-flopping) */
export type SystemVerdict = { bias: string; vol: string; evidence: string[] };

export type BriefingSnapshot = {
  kind: BriefingKind;
  /** ISO instant the snapshot was built */
  generatedAt: string;
  /** "YYYY-MM-DD" New York */
  etDay: string;
  /** "HH:MM" New York */
  etClock: string;
  marketOpen: boolean;
  /** the ETH session date key ("YYYY-MM-DD" the session closes on) */
  sessionDay: string;
  nq: {
    lastClose: number | null;
    prevSessionClose: number | null;
    changePct: number | null;
    sessionHigh: number | null;
    sessionLow: number | null;
    cumulativeDelta: number | null;
    volume: number | null;
    /** realized daily 1σ % from the live 1-min tape */
    realizedBandPct: number | null;
    /** VIX/16 daily 1σ % (delayed daily twin) */
    vixBandPct: number | null;
    vixBandPts: number | null;
    bars: number | null;
    firstBar: string | null;
    lastBar: string | null;
    /** 0-100: where the last close sits inside the session range */
    closePosPct: number | null;
    /** the most recent CLOSED session (for weekends/pre-open) */
    prevHigh: number | null;
    prevLow: number | null;
    prevCumulativeDelta: number | null;
    /** 0-100: where the prior session's close sits in ITS range */
    prevClosePosPct: number | null;
    /** key levels precomputed in NQ POINTS (GEX already converted
     *  QQQ→NQ via the spot ratio — the model must copy these verbatim) */
    levels: SnapshotLevel[];
    /** numeric twin of `levels` — what the chart draws as hlines */
    lines: SnapshotLine[];
  };
  /** the code-decided bias + vol the model must use verbatim */
  systemVerdict: SystemVerdict;
  rates: {
    y2: number | null;
    y10: number | null;
    y30: number | null;
    /** "YYYY-MM-DD" of the official curve print (lags a session) */
    curveDate: string | null;
    y10ChangeBps: number | null;
    spread210: number | null;
    spread103m: number | null;
    breakeven10y: number | null;
    real10y: number | null;
    effr: { date: string | null; rate: number | null; targetFrom: number | null; targetTo: number | null } | null;
    /** CNBC intraday row — ~20 min delayed */
    intraday: { y2: number | null; y10: number | null; asOf: string | null } | null;
    impliedFfr: number | null;
  } | null;
  news: {
    source: string | null;
    fetchedAt: string | null;
    today: SnapshotNewsItem[];
    upcoming: SnapshotNewsItem[];
  };
  earnings: {
    provider: string | null;
    asOf: string | null;
    today: SnapshotEarningsItem[];
    upcoming: SnapshotEarningsItem[];
  };
  watch: {
    quotesAt: string | null;
    quotes: SnapshotQuote[];
    vix: { level: number | null; pct1y: number | null; rangePct: number | null; at: string | null } | null;
    /** GEX is in QQQ points, not NQ — the label says so */
    gex: { regime: string; spot: number | null; flip: number | null; callWall: number | null; putWall: number | null; unit: "QQQ points" } | null;
    htf: { daily: string | null; weekly: string | null; at: string | null } | null;
    fred: {
      hyOasPct: number | null;
      hyOasDelta: number | null;
      walclT: number | null;
      walclDeltaT: number | null;
      rrpB: number | null;
      tgaB: number | null;
      at: string | null;
    } | null;
    cot: { netPctOi: number | null; pct52w: number | null; asOf: string | null } | null;
    calendar: {
      opex: { day: string; quad: boolean; days: number } | null;
      auctions: { label: string; day: string; days: number }[];
      fomcMinutes: { day: string; days: number; approx: boolean } | null;
    } | null;
    errors: string[];
  };
  staleness: {
    bonds: { ok: boolean; stale: boolean; fetchedAt: string | null; error: string | null };
    news: { ok: boolean; stale: boolean; fetchedAt: string | null; error: string | null };
    earnings: { ok: boolean; stale: boolean; fetchedAt: string | null; error: string | null };
  };
};

/* ---------------------------------------------------------------- *
 * DeepSeek JSON-mode payload
 * ---------------------------------------------------------------- */

export const BRIEFING_SCHEMA_EXAMPLE: Omit<BriefingContent, "bias" | "vol"> = {
  headline: "EXAMPLE — one-line bottom line using the systemVerdict bias word (up/down/chop)",
  read: [
    "EXAMPLE why — the macro driver behind the verdict, citing the evidence",
    "EXAMPLE fragility — what is priced in too far",
  ],
  watchFors: [
    "EXAMPLE — a condition reachable today, referencing a level from snapshot.nq.levels by its label and price",
    "EXAMPLE — 'losing session low 30,470 flips the bias down'",
  ],
  caveats: ["EXAMPLE — 'CNBC ~20 min delayed'"],
};

const SYSTEM_PROMPT = [
  "You are the macro interpreter for a personal NQ (Nasdaq-100 futures) scalping dashboard.",
  "The dashboard already shows every number. A scalper reads your output BETWEEN TICKS:",
  "maximum density, minimum words.",
  "",
  "You receive ONE JSON snapshot of macro-context data: US Treasury curve (official daily +",
  "delayed intraday), the week's US economic calendar, Nasdaq-100 earnings, a cross-asset/regime",
  "watch (VIX, DXY, SPX, NDX, SOX, gold, crude, BTC, GEX, HTF swing structure, liquidity,",
  "positioning), and NQ price context from the live 1-minute tape.",
  "",
  "The user wants exactly two things: (1) the BIAS — up, down or chop, (2) what would change it.",
  "THE BIAS IS PRE-DECIDED: snapshot.systemVerdict is computed in code from the tape (with its",
  "evidence listed). Use systemVerdict.bias and systemVerdict.vol VERBATIM — do not output bias or",
  "vol fields (they are ignored), and never argue for a different bias. If the macro genuinely",
  "contradicts the verdict, say so inside read[0] while keeping the verdict.",
  "Key levels are ALREADY computed for you in snapshot.nq.levels as NQ prices (GEX walls/flip are",
  "converted QQQ→NQ in code) — reference them by label and price, never invent other prices.",
  "",
  "Rules:",
  "1. The headline is the bottom line, ≤15 words, and MUST contain the systemVerdict.bias word",
  "(up/down/chop) — it must not contradict it.",
  "2. read: ≤2 bullets, each ≤18 words: why the verdict (cite systemVerdict.evidence + the macro",
  "driver) and the fragility (what is priced in too far). Cite numbers only to support the conclusion.",
  "3. watchFors: ≤3 conditions that would change the bias TODAY, each referencing a level from",
  "snapshot.nq.levels (by label AND its NQ price) or a quote, each ≤20 words. No far-away",
  "hypotheticals.",
  "4. caveats: data-vintage warnings ONLY (delayed/stale/unavailable). ≤2, each ≤10 words.",
  "5. VINTAGES: daily prints (curve, VIX stats, FRED, COT, HTF) are NOT intraday; CNBC quotes",
  "are ~20 min delayed; the realized band is live. State the vintage when it changes the meaning.",
  "6. null means the source is unavailable — say so, never invent a number. If the current NQ",
  "session has no bars, use the previous session (prev* fields) and say the tape has not opened.",
  "7. DISPLAY-ONLY context for the human trader; it never feeds a signal engine. Analysis of the",
  "situation only — no trade instructions, orders, or disclaimers.",
  "8. JSON GRAMMAR (strict): every string must be a SINGLE line — never a literal newline",
  "inside a string value. Emit ONLY the JSON object, nothing else.",
  "9. The example shows SHAPE ONLY — its words and prices are placeholders. Every claim and",
  "number must come from the snapshot; never reuse an example sentence.",
].join("\n");

/** the OpenAI-compatible chat payload for DeepSeek (JSON mode).
 *  Thinking is DISABLED: v4 models reason by default at high effort and
 *  the reasoning tokens eat the max_tokens budget, which the docs note
 *  can yield an empty `content` in JSON mode — a structured summary
 *  wants the fast, deterministic path. */
export function buildBriefingPayload(
  snapshot: BriefingSnapshot,
  model: string,
): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format: { type: string };
  thinking: { type: string };
  max_tokens: number;
} {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          task: `Produce a ${snapshot.kind} macro briefing for the NQ session.`,
          exampleJsonOutput: BRIEFING_SCHEMA_EXAMPLE,
          snapshot,
        }),
      },
    ],
    response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    max_tokens: 2000,
  };
}

/* ---------------------------------------------------------------- *
 * response parsing
 * ---------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v : fallback);

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** DeepSeek JSON-mode responses are occasionally empty or malformed —
 *  this returns null on anything that is not a usable object, and the
 *  caller falls back to the deterministic renderer. Tolerant of the two
 *  failure modes observed live: markdown fences and literal newlines
 *  inside string values (models ignore the single-line rule). */
export function parseBriefingContent(raw: string | null | undefined): BriefingContent | null {
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
  if (j === null || !isObj(j)) return null;
  if (typeof j.headline !== "string" && typeof j.bias !== "string") return null;
  return {
    headline: str(j.headline, "no read"),
    bias: str(j.bias, "chop"),
    vol: str(j.vol, "normal"),
    read: strArr(j.read),
    watchFors: strArr(j.watchFors),
    caveats: strArr(j.caveats),
  };
}

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

/* ---------------------------------------------------------------- *
 * deterministic fallback — rules-built over the same snapshot, so the
 * card is never blank when the LLM is unavailable
 * ---------------------------------------------------------------- */

const nqFmt = (v: number | null): string => (v == null ? "n/a" : v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));

/** the tape-scorer: one deterministic verdict per snapshot. The model is
 *  NOT allowed to change it — it only explains it (see the system prompt).
 *  Weights: current-session tape first; when the session has no bars yet
 *  (weekend/pre-open), the prior session's close position + delta stand in. */
function biasParts(s: BriefingSnapshot): { score: number; parts: string[] } {
  const nq = s.nq;
  const parts: string[] = [];
  let score = 0;
  const add = (w: number, label: string) => {
    if (w === 0) return;
    score += w;
    parts.push(`${w >= 0 ? "+" : ""}${w} ${label}`);
  };
  const hasTape = (nq.bars ?? 0) > 0;
  if (hasTape) {
    if (nq.changePct != null) add(nq.changePct > 0.1 ? 1 : nq.changePct < -0.1 ? -1 : 0, `chg ${nq.changePct}%`);
    if (nq.closePosPct != null) add(nq.closePosPct > 65 ? 1 : nq.closePosPct < 35 ? -1 : 0, `close ${nq.closePosPct}% of range`);
    if (nq.cumulativeDelta != null) add(nq.cumulativeDelta > 2000 ? 1 : nq.cumulativeDelta < -2000 ? -1 : 0, `delta ${nq.cumulativeDelta.toLocaleString()}`);
  } else {
    if (nq.prevClosePosPct != null) add(nq.prevClosePosPct > 65 ? 1 : nq.prevClosePosPct < 35 ? -1 : 0, `prior close ${nq.prevClosePosPct}% of range`);
    if (nq.prevCumulativeDelta != null) add(nq.prevCumulativeDelta > 2000 ? 1 : nq.prevCumulativeDelta < -2000 ? -1 : 0, `prior delta ${nq.prevCumulativeDelta.toLocaleString()}`);
  }
  const htf = s.watch.htf?.daily ?? null;
  if (htf === "HH/HL") add(1, "HTF HH/HL");
  if (htf === "LH/LL") add(-1, "HTF LH/LL");
  const gex = s.watch.gex;
  if (gex?.regime === "trend" && gex.spot != null && gex.flip != null) {
    add(gex.spot > gex.flip ? 1 : -1, `GEX ${gex.spot > gex.flip ? "above" : "below"} flip`);
  }
  const q = (sym: string) => s.watch.quotes.find((x) => x.symbol === sym)?.changePct ?? null;
  const spx = q(".SPX");
  const ndx = q(".NDX");
  if (spx != null) add(spx > 0.3 ? 0.5 : spx < -0.3 ? -0.5 : 0, `SPX ${spx}%`);
  if (ndx != null) add(ndx > 0.3 ? 0.5 : ndx < -0.3 ? -0.5 : 0, `NDX ${ndx}%`);
  return { score, parts };
}

export function biasOf(s: BriefingSnapshot): string {
  const { score } = biasParts(s);
  if (score >= 1) return "up";
  if (score <= -1) return "down";
  return "chop";
}

export function volOf(s: BriefingSnapshot): string {
  const v = s.watch.vix?.level ?? null;
  if (v == null) return "normal";
  if (v < 14) return "compressed";
  if (v < 22) return "normal";
  if (v < 30) return "elevated";
  return "extreme";
}

/** the code-decided bias + vol handed to the model — the single source of
 *  truth so reruns over the same data can never flip-flop */
export function systemVerdictOf(s: BriefingSnapshot): SystemVerdict {
  const { score, parts } = biasParts(s);
  const v = s.watch.vix?.level ?? null;
  return {
    bias: biasOf(s),
    vol: volOf(s),
    evidence: [...parts, `score ${score >= 0 ? "+" : ""}${score} → ${biasOf(s)}`, v != null ? `VIX ${v} → ${volOf(s)}` : "VIX n/a → normal"],
  };
}

/** guard: the headline must carry the verdict's word. Replaces a LEADING
 *  "Up/Down/Chop" label (the typical shape) when the model drifts. */
export function enforceHeadlineBias(headline: string, bias: string): string {
  return headline.replace(/^(up|down|chop)\b/i, (m) => (m.toLowerCase() === bias ? m : bias === "up" ? "Up" : bias === "down" ? "Down" : "Chop"));
}

export function renderDeterministicBriefing(s: BriefingSnapshot): BriefingContent {
  const nq = s.nq;
  const bias = biasOf(s);
  const vol = volOf(s);
  const q = (sym: string) => s.watch.quotes.find((x) => x.symbol === sym)?.changePct ?? null;
  const hasBars = (nq.bars ?? 0) > 0;

  const headline =
    `${bias.toUpperCase()}${hasBars ? ` · NQ ${nqFmt(nq.lastClose)}` : ` · NQ ${nqFmt(nq.prevSessionClose)} (prior close)`}` +
    `${nq.realizedBandPct != null ? ` · realized 1σ ±${nq.realizedBandPct}%` : ""}` +
    ` — ${bias === "chop" ? "range until a level breaks" : `${bias === "up" ? "bid intact" : "offer intact"} until a watch-for breaks`}.`;

  /* ---- the why (≤2 bullets) ---- */
  const read: string[] = [];
  const sox = q(".SOX");
  const spx = q(".SPX");
  if (sox != null && spx != null && sox - spx > 0.5) read.push(`semis leading (SOX ${sox >= 0 ? "+" : ""}${sox.toFixed(1)}% vs SPX ${spx >= 0 ? "+" : ""}${spx.toFixed(1)}%) — a growth/AI bid, not a rotation`);
  const vixPct = s.watch.vix?.pct1y ?? null;
  if (vixPct != null && s.watch.vix?.level != null) {
    if (vixPct <= 20) read.push(`VIX 1y ${vixPct}th percentile — complacency; dips get bought, and that is the fragility`);
    else if (vixPct >= 80) read.push(`VIX 1y ${vixPct}th percentile — fear is the driver, rallies get sold`);
  }
  if (s.rates?.spread210 != null && s.rates.y10ChangeBps != null && s.rates.spread210 > 0 && s.rates.y10ChangeBps > 0) {
    read.push(`curve steepening (2s10s +${s.rates.spread210}bps) while equities hold — pricing growth, not a policy mistake`);
  }
  if (read.length === 0) read.push(hasBars ? "macro drivers are thin — the tape itself is the read" : "insufficient data for a macro read");

  /* ---- watch-fors: conditions with prices (levels are precomputed
   *      in snapshot.nq.levels; the card renders them directly) ---- */
  const watchFors: string[] = [];
  if (nq.sessionLow != null) watchFors.push(`losing ${nqFmt(nq.sessionLow)} (session low) flips the bias ${bias === "down" ? "further down" : "down"}`);
  if (nq.sessionHigh != null) watchFors.push(`clearing ${nqFmt(nq.sessionHigh)} (session high) flips the bias ${bias === "up" ? "further up" : "up"}`);
  const flipNq = nq.levels.find((l) => l.label === "GEX flip")?.value ?? null;
  if (flipNq) watchFors.push(`holding ${flipNq} (GEX flip, NQ) — below it dealers sell into weakness`);
  if (s.rates?.y10 != null) watchFors.push(`10Y closing above ${(s.rates.y10 + 0.1).toFixed(2)}% starts repressing NDX multiples`);
  if (watchFors.length === 0) watchFors.push("no levels available to define watch-fors");
  const watchCapped = watchFors.slice(0, 3);

  /* ---- caveats: data vintages only ---- */
  const caveats: string[] = [];
  const staleNames = Object.entries(s.staleness)
    .filter(([, st]) => st.error || st.stale || !st.ok)
    .map(([name]) => name);
  if (staleNames.length) caveats.push(`${staleNames.join("/")} stale or unavailable`);
  if (s.watch.errors.length) caveats.push(`watch errors: ${s.watch.errors.length}`);
  if (s.watch.quotesAt) caveats.push("CNBC ~20 min delayed");
  if (caveats.length === 0) caveats.push("all sources fresh");

  return { headline, bias, vol, read: read.slice(0, 2), watchFors: watchCapped, caveats: caveats.slice(0, 2) };
}

/* ---------------------------------------------------------------- *
 * chart lines — map the snapshot's numeric level lines to colored
 * horizontal chart overlays. Accepts the loose jsonb shape so the
 * card can call it on a stored row's snapshot directly.
 * ---------------------------------------------------------------- */

const LINE_COLORS: Record<string, string> = {
  flip: "#fbbf24", // warn — the dealer pivot
  "call wall": "#38bdf8", // info — overhead magnet
  "put wall": "#34d399", // long — support floor
  high: "#a1a1aa", // session/prior extremes
  low: "#a1a1aa",
  band: "#71717a", // VIX 1σ edges
};

export function chartLinesOfSnapshot(snap: unknown): ChartLine[] {
  const s = (snap ?? {}) as { nq?: { lines?: unknown } };
  const raw = s?.nq?.lines;
  if (!Array.isArray(raw)) return [];
  const out: ChartLine[] = [];
  for (const l of raw) {
    if (typeof l !== "object" || l === null) continue;
    const o = l as Record<string, unknown>;
    const price = typeof o.price === "number" ? o.price : Number(o.price);
    if (!Number.isFinite(price)) continue;
    const label = typeof o.label === "string" ? o.label : "";
    const tone = typeof o.tone === "string" ? o.tone : "";
    out.push({ label, price, color: LINE_COLORS[tone] ?? "#a1a1aa" });
  }
  return out;
}
