/* ------------------------------------------------------------------ *
 * Macro interpretation — the orchestrator behind the Macro tab's AI
 * interpretation layer (per-metric reads, per-family combination
 * reads, the combined all-families read on top).
 *
 * DISPLAY-ONLY, like the rest of the macro layer: this module is
 * imported ONLY by /api/macro-interpret and scripts/macroInterpret.ts.
 * The signal engine never sees it.
 *
 * Pipeline: getMacroContext() (the same macro sources the panels
 * show) → build the metric snapshot (values + directions) → DeepSeek
 * JSON-mode call → merge with the deterministic renderer (lib/
 * interpretText.ts) → one row in `macro_interpretations`. Any failure
 * degrades to the deterministic renderer — the tab is never blank.
 *
 * Env: ANALYSIS_LLM_URL + ANALYSIS_LLM_KEY (same keys as the briefing
 * and nightly insights jobs); INTERPRET_LLM_MODEL overrides the model
 * (default deepseek-v4-pro).
 * ------------------------------------------------------------------ */

import { getMacroContext } from "./macroFeed";
import { dbEnabled, getDb } from "./gcdb";
import { etNow, impliedFfr, signed, dayLabel, shortDate, daysAway, nextUpcoming } from "./macroFmt";
import { bpDiff, spread210, spread103m, real10y, breakeven10y } from "./bonds";
import {
  buildInterpretPayload,
  mergeInterpretContent,
  parseInterpretContent,
  renderDeterministicInterpret,
  type InterpretCombined,
  type InterpretContent,
  type InterpretDirection,
  type InterpretFamilyRead,
  type InterpretMetricRead,
  type InterpretMetricValue,
  type InterpretSnapshot,
} from "./interpretText";
import type { MetricFamily } from "./macroGuide";
import { METRIC_GUIDES } from "./macroGuide";

/* ---------------------------------------------------------------- *
 * persistence
 * ---------------------------------------------------------------- */

export const SCHEMA_SQL = `
create table if not exists macro_interpretations (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  generated_at timestamptz not null default now(),
  model text not null default '',
  source text not null default 'deterministic',
  combined jsonb not null default '{}'::jsonb,
  families jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '[]'::jsonb,
  snapshot jsonb not null default '{}'::jsonb
);
create index if not exists macro_interpretations_idx on macro_interpretations (run_at desc);
`;

export type InterpretRow = {
  id: number;
  run_at: string;
  generated_at: string;
  model: string;
  source: "llm" | "deterministic";
  combined: InterpretCombined;
  families: InterpretFamilyRead[];
  metrics: InterpretMetricRead[];
  snapshot: InterpretSnapshot;
};

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v as T; // postgres driver already parsed jsonb
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** timestamptz arrives as a Date from the driver — keep ISO for JSON */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

function rowOf(r: Record<string, unknown>): InterpretRow {
  return {
    id: Number(r.id),
    run_at: iso(r.run_at),
    generated_at: iso(r.generated_at),
    model: String(r.model ?? ""),
    source: String(r.source ?? "deterministic") as InterpretRow["source"],
    combined: parseJson<InterpretCombined>(r.combined, { headline: "", stance: "mixed", read: [], caveats: [] }),
    families: parseJson<InterpretFamilyRead[]>(r.families, []),
    metrics: parseJson<InterpretMetricRead[]>(r.metrics, []),
    snapshot: parseJson<InterpretSnapshot>(r.snapshot, { generatedAt: "", etDay: "", etClock: "", metrics: [], staleness: { bonds: false, news: false, earnings: false }, errors: [] }),
  };
}

export async function persistInterpretation(
  content: InterpretContent,
  snapshot: InterpretSnapshot,
  source: "llm" | "deterministic",
  model: string,
): Promise<InterpretRow | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  await db.unsafe(SCHEMA_SQL);
  const rows = await db`
    insert into macro_interpretations
      (generated_at, model, source, combined, families, metrics, snapshot)
    values (now(), ${model}, ${source}, ${JSON.stringify(content.combined)},
            ${JSON.stringify(content.families)}, ${JSON.stringify(content.metrics)},
            ${JSON.stringify(snapshot)})
    returning *`;
  // Neon Free is 512 MB — keep a bounded history
  await db`delete from macro_interpretations where run_at < now() - interval '30 days'`;
  return rows.length ? rowOf(rows[0] as unknown as Record<string, unknown>) : null;
}

export async function latestInterpretation(): Promise<InterpretRow | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  try {
    await db.unsafe(SCHEMA_SQL);
    const rows = (await db`select * from macro_interpretations order by run_at desc, id desc limit 1`) as unknown as Record<string, unknown>[];
    return rows.length ? rowOf(rows[0]) : null;
  } catch (e) {
    console.warn(`[macro-interpret] read failed (${String(e)})`);
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * snapshot assembly
 * ---------------------------------------------------------------- */

/** the fields this module reads from the (optional) bias-chips layer */
type BiasChipsShape = {
  score: number | null;
  sideLean: string[];
  gapPct: number | null;
  gap: { regime: string | null };
  vixGate: { fadeOk: boolean | null };
};

const pct = (v: number | null, dp = 2): string => (v == null ? "—" : v.toFixed(dp));

const num = (v: number | null | undefined, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/** signed day change → up/down/flat (|x| < eps = flat) */
const dirOf = (delta: number | null, eps: number): InterpretDirection =>
  delta == null || !Number.isFinite(delta) ? null : delta >= eps ? "up" : delta <= -eps ? "down" : "flat";

/** level band: ≥hi = up, ≤lo = down, else flat */
const bandOf = (v: number | null, hi: number, lo: number): InterpretDirection =>
  v == null || !Number.isFinite(v) ? null : v >= hi ? "up" : v <= lo ? "down" : "flat";

function etClockNow(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  return `${g.hour}:${g.minute}`;
}

export async function buildInterpretSnapshot(): Promise<InterpretSnapshot> {
  const ctx = await getMacroContext();
  const now = etNow();
  const w = ctx.watch;
  const vix = w?.vix ?? null;
  const quotes = w?.quotes ?? [];
  const q = (sym: string) => quotes.find((x) => x.symbol === sym) ?? null;
  const gex = w?.gex ?? null;
  const fred = w?.fred ?? null;
  const cot = w?.cot ?? null;
  const cal = w?.calendar ?? null;
  /* the bias-chips layer rides in the archive's WIP (lib/biasChips.ts);
   * read it through a structural shape so this module compiles and runs
   * whether or not the field exists yet */
  const bias = (w as { bias?: BiasChipsShape | null } | null)?.bias ?? null;
  const bondsData = ctx.bonds.data;
  const latest = bondsData?.latest ?? null;
  const prev = bondsData?.curve?.[1] ?? null;

  const ffPrice = q("@FF.1")?.value ?? null;
  const ffrImpled = impliedFfr(ffPrice);
  const s210 = latest ? spread210(latest) : null;
  const s103m = latest ? spread103m(latest) : null;
  const realNow = latest ? real10y({ date: latest.date, y10: latest.y10 }, bondsData?.real ?? []) : null;
  const realPrev = prev ? real10y({ date: prev.date, y10: prev.y10 }, bondsData?.real ?? []) : null;
  const beNow = latest ? breakeven10y({ date: latest.date, y10: latest.y10 }, bondsData?.real ?? []) : null;
  const bePrev = prev ? breakeven10y({ date: prev.date, y10: prev.y10 }, bondsData?.real ?? []) : null;

  const nextNews = nextUpcoming(ctx.news.data);
  const earnUp = (ctx.earnings.data?.upcoming ?? []).filter(
    (r): r is (typeof r) & { nextDate: string } => r.nextDate != null && daysAway(r.nextDate, now.day) >= 0,
  )[0];

  const out: InterpretMetricValue[] = [];
  const put = (id: string, family: MetricFamily, label: string, value: string, direction: InterpretDirection, n: number | null, delta: number | null) =>
    out.push({ id, family, label, value, direction, num: n, delta });

  /* ---- risk ---- */
  const gexFlipDist = gex && gex.flip != null && gex.spot != null ? num(gex.flip - gex.spot, 1) : null;
  const callDist = gex && gex.callWall != null && gex.spot != null ? num(gex.callWall - gex.spot, 1) : null;
  const putDist = gex && gex.putWall != null && gex.spot != null ? num(gex.spot - gex.putWall, 1) : null;
  put("vix.level", "risk", "VIX", pct(vix?.level ?? null), bandOf(vix?.level ?? null, 22, 14), num(vix?.level ?? null), num(q(".VIX")?.change ?? null));
  put("vix.pct1y", "risk", "VIX 1y pctile", vix?.pct1y != null ? `${vix.pct1y}th` : "—", bandOf(vix?.pct1y ?? null, 66, 34), num(vix?.pct1y ?? null, 0), null);
  put("vix.term9d", "risk", "VIX 9d", pct(vix?.term9d ?? null), vix?.term9d != null && vix.level != null ? dirOf(vix.term9d - vix.level, 1) : null, num(vix?.term9d ?? null), null);
  put("vix.term3m", "risk", "VIX 3m", pct(vix?.term3m ?? null), vix?.term3m != null && vix.level != null ? dirOf(vix.term3m - vix.level, 1) : null, num(vix?.term3m ?? null), null);
  put("vix.rangePct", "risk", "VIX 1σ day", vix?.rangePct != null ? `${vix.rangePct.toFixed(2)}%` : "—", bandOf(vix?.rangePct ?? null, 1.2, 0.75), num(vix?.rangePct ?? null), null);
  put("gex.regime", "risk", "GEX regime", gex ? gex.regime.toUpperCase() : "—", null, null, null);
  put("gex.flipDist", "risk", "GEX flip", gexFlipDist != null ? `${gexFlipDist > 0 ? "+" : ""}${gexFlipDist}` : "—", gexFlipDist == null ? null : gexFlipDist >= 0 ? "up" : "down", gexFlipDist, null);
  put("gex.callWall", "risk", "Call wall", callDist != null ? `${callDist}` : "—", callDist == null ? null : callDist >= 40 ? "up" : callDist <= 15 ? "down" : "flat", callDist, null);
  put("gex.putWall", "risk", "Put wall", putDist != null ? `${putDist}` : "—", putDist == null ? null : putDist <= 15 ? "up" : putDist >= 40 ? "down" : "flat", putDist, null);

  /* ---- rates ---- */
  put("rates.y2", "rates", "2Y", latest?.y2 != null ? `${latest.y2.toFixed(2)}%` : "—", dirOf(bpDiff(latest?.y2 ?? null, prev?.y2 ?? null), 1), num(latest?.y2 ?? null), bpDiff(latest?.y2 ?? null, prev?.y2 ?? null));
  put("rates.y10", "rates", "10Y", latest?.y10 != null ? `${latest.y10.toFixed(2)}%` : "—", dirOf(bpDiff(latest?.y10 ?? null, prev?.y10 ?? null), 1), num(latest?.y10 ?? null), bpDiff(latest?.y10 ?? null, prev?.y10 ?? null));
  put("rates.y30", "rates", "30Y", latest?.y30 != null ? `${latest.y30.toFixed(2)}%` : "—", dirOf(bpDiff(latest?.y30 ?? null, prev?.y30 ?? null), 1), num(latest?.y30 ?? null), bpDiff(latest?.y30 ?? null, prev?.y30 ?? null));
  put("rates.spread210", "rates", "2s10s", s210 != null ? `${signed(s210, 0)} bp` : "—", bandOf(s210, 25, -25), num(s210, 0), null);
  put("rates.spread103m", "rates", "10y−3m", s103m != null ? `${signed(s103m, 0)} bp` : "—", s103m == null ? null : s103m >= 0 ? "up" : "down", num(s103m, 0), null);
  put("rates.real10y", "rates", "10Y real", realNow != null ? `${realNow.toFixed(2)}%` : "—", dirOf(bpDiff(realNow, realPrev), 1), num(realNow), bpDiff(realNow, realPrev));
  put("rates.breakeven10y", "rates", "Breakevens", beNow != null ? `${beNow.toFixed(2)}%` : "—", dirOf(bpDiff(beNow, bePrev), 1), num(beNow), bpDiff(beNow, bePrev));
  put("rates.ffrImpled", "rates", "FFR implied", ffrImpled != null ? `${ffrImpled.toFixed(2)}%` : "—", null, num(ffrImpled), null);
  put("rates.effr", "rates", "EFFR", bondsData?.effr?.rate != null ? `${bondsData.effr.rate.toFixed(2)}%` : "—", null, num(bondsData?.effr?.rate ?? null), null);
  put("rates.y10ChangeBps", "rates", "10Y day Δ", bpDiff(latest?.y10 ?? null, prev?.y10 ?? null) != null ? `${signed(bpDiff(latest?.y10 ?? null, prev?.y10 ?? null), 0)} bp` : "—", dirOf(bpDiff(latest?.y10 ?? null, prev?.y10 ?? null), 1), num(bpDiff(latest?.y10 ?? null, prev?.y10 ?? null), 0), bpDiff(latest?.y10 ?? null, prev?.y10 ?? null));

  /* ---- fx & equities / commodities / crypto quotes ---- */
  const quoteCfg: { sym: string; id: string; family: MetricFamily; label: string }[] = [
    { sym: ".DXY", id: "dxy", family: "fx-equities", label: "DXY" },
    { sym: ".SPX", id: "spx", family: "fx-equities", label: "S&P 500" },
    { sym: ".NDX", id: "ndx", family: "fx-equities", label: "Nasdaq-100" },
    { sym: ".SOX", id: "sox", family: "fx-equities", label: "SOX semis" },
    { sym: "SPY", id: "spy", family: "fx-equities", label: "SPY" },
    { sym: "RSP", id: "rsp", family: "fx-equities", label: "RSP eq-wt" },
    { sym: "SMH", id: "smh", family: "fx-equities", label: "SMH semis" },
    { sym: "QQQ", id: "qqq", family: "fx-equities", label: "QQQ" },
    { sym: "@GC.1", id: "gold", family: "commodities", label: "Gold" },
    { sym: "@CL.1", id: "wti", family: "commodities", label: "WTI crude" },
    { sym: "BTC.CB=", id: "btc", family: "crypto", label: "Bitcoin" },
  ];
  for (const cfg of quoteCfg) {
    const qq = q(cfg.sym);
    const value = qq?.value ?? null;
    put(cfg.id, cfg.family, cfg.label, pct(value), dirOf(qq?.changePct ?? null, 0.05), num(value), num(qq?.changePct ?? null));
  }

  /* ---- liquidity & positioning ---- */
  const walclDeltaT = fred?.walcl?.delta != null ? num(fred.walcl.delta / 1e12, 2) : null;
  put(
    "fred.walcl", "liquidity", "Fed B/S",
    fred?.walcl?.value != null ? `${(fred.walcl.value / 1e12).toFixed(2)}T${walclDeltaT == null ? "" : walclDeltaT < 0 ? " QT" : walclDeltaT > 0 ? " QE" : ""}` : "—",
    walclDeltaT == null ? null : walclDeltaT < 0 ? "down" : walclDeltaT > 0 ? "up" : "flat",
    num(fred?.walcl?.value ?? null), walclDeltaT,
  );
  put("fred.rrp", "liquidity", "RRP", fred?.rrp?.value != null ? `${(fred.rrp.value / 1e9).toFixed(0)}B` : "—", dirOf(fred?.rrp?.delta != null ? fred.rrp.delta / 1e9 : null, 1), num(fred?.rrp?.value ?? null), fred?.rrp?.delta != null ? num(fred.rrp.delta / 1e9, 0) : null);
  put("fred.tga", "liquidity", "TGA", fred?.tga?.value != null ? `${(fred.tga.value / 1e9).toFixed(0)}B` : "—", dirOf(fred?.tga?.delta != null ? fred.tga.delta / 1e9 : null, 1), num(fred?.tga?.value ?? null), fred?.tga?.delta != null ? num(fred.tga.delta / 1e9, 0) : null);
  put("fred.hyOas", "liquidity", "HY OAS", fred?.hyOas?.value != null ? `${fred.hyOas.value.toFixed(2)}%` : "—", dirOf(fred?.hyOas?.delta ?? null, 0.05), num(fred?.hyOas?.value ?? null), num(fred?.hyOas?.delta ?? null));
  put("cot.netPctOi", "liquidity", "COT net", cot?.netPctOi != null ? `${signed(cot.netPctOi, 1)}%` : "—", bandOf(cot?.netPctOi ?? null, 10, -10), num(cot?.netPctOi ?? null, 1), null);
  put("cot.pct52w", "liquidity", "COT 52w", cot?.pct52w != null ? `${cot.pct52w}th` : "—", bandOf(cot?.pct52w ?? null, 66, 34), num(cot?.pct52w ?? null, 0), null);

  /* ---- calendar & events ---- */
  put("calendar.opex", "calendar", "OPEX", cal?.opex ? `${shortDate(cal.opex.day)}${cal.opex.quad ? " quad" : ""} · ${cal.opex.days}d` : "—", null, null, null);
  put("calendar.auctions", "calendar", "Auctions", cal && cal.auctions.length > 0 ? cal.auctions.slice(0, 2).map((a) => `${a.label} ${shortDate(a.day)}`).join(" · ") : "—", null, null, null);
  put("calendar.fomcMinutes", "calendar", "FOMC mins", cal?.fomcMinutes ? `~${shortDate(cal.fomcMinutes.day)} · ${cal.fomcMinutes.days}d` : "—", null, null, null);
  put("news.next", "calendar", "Next release", nextNews ? `${nextNews.title} · ${dayLabel(nextNews.day)} ${nextNews.timeET ?? ""}`.trim() : "—", null, null, null);
  put("earnings.next", "calendar", "Next earnings", earnUp ? `${earnUp.symbol} · ${shortDate(earnUp.nextDate)}${daysAway(earnUp.nextDate, now.day) === 0 ? " today" : ` in ${daysAway(earnUp.nextDate, now.day)}d`}` : "—", null, null, null);

  /* ---- structure ---- */
  const htfD = w?.htf?.daily ?? null;
  const htfW = w?.htf?.weekly ?? null;
  put("htf.daily", "structure", "HTF daily", htfD ?? "—", htfD === "HH/HL" ? "up" : htfD === "LH/LL" ? "down" : htfD === "CHOP" ? "flat" : null, null, null);
  put("htf.weekly", "structure", "HTF weekly", htfW ?? "—", htfW === "HH/HL" ? "up" : htfW === "LH/LL" ? "down" : htfW === "CHOP" ? "flat" : null, null, null);
  put("bias.score", "structure", "Structure score", bias?.score != null ? signed(bias.score, 0) : "—", bandOf(bias?.score ?? null, 1, -1), num(bias?.score ?? null, 0), null);
  put("bias.gapPct", "structure", "Gap %", bias?.gapPct != null ? `${signed(bias.gapPct, 2)}%` : "—", bandOf(bias?.gapPct ?? null, 0.5, -0.5), num(bias?.gapPct ?? null), null);
  put("bias.gapRegime", "structure", "Gap regime", bias?.gap.regime ?? "—", null, null, null);
  put("bias.fadeOk", "structure", "Fade gate", bias?.vixGate.fadeOk == null ? "—" : bias.vixGate.fadeOk ? "fades ok" : "no fades", bias?.vixGate.fadeOk == null ? null : bias.vixGate.fadeOk ? "up" : "down", null, null);
  put("bias.sideLean", "structure", "Side cells", bias?.sideLean[0] ?? "—", null, null, null);

  /* keep the guide order (the card and the prompt follow it) */
  const byId = new Map(out.map((m) => [m.id, m]));
  const metrics = METRIC_GUIDES.map((g) => byId.get(g.id)).filter((m): m is InterpretMetricValue => !!m);

  return {
    generatedAt: new Date().toISOString(),
    etDay: now.day,
    etClock: etClockNow(),
    metrics,
    staleness: { bonds: !ctx.bonds.ok, news: !ctx.news.ok, earnings: !ctx.earnings.ok },
    errors: w?.errors ?? [],
  };
}

/* ---------------------------------------------------------------- *
 * DeepSeek call + generation
 * ---------------------------------------------------------------- */

export function interpretModel(): string {
  return process.env.INTERPRET_LLM_MODEL ?? "deepseek-v4-pro";
}

export async function callDeepSeekInterpret(
  payload: ReturnType<typeof buildInterpretPayload>,
  url: string,
  key: string,
): Promise<ReturnType<typeof parseInterpretContent>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.warn(`[macro-interpret] LLM ${res.status} — deterministic fallback`);
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = j.choices?.[0]?.message?.content;
    const parsed = parseInterpretContent(raw);
    if (!parsed) {
      console.warn(`[macro-interpret] LLM returned unparseable content (${String(raw ?? "").slice(0, 200)}) — deterministic fallback`);
    }
    return parsed;
  } catch (e) {
    console.warn(`[macro-interpret] LLM failed (${String(e)}) — deterministic fallback`);
    return null;
  }
}

/** the full generation path, shared by the CLI and the refresh route.
 *  Never throws: LLM failure degrades to the deterministic renderer,
 *  DB failure returns null (the tab shows its own empty state). */
export async function generateInterpretation(): Promise<{ row: InterpretRow | null; source: "llm" | "deterministic" }> {
  const snapshot = await buildInterpretSnapshot();
  const det = renderDeterministicInterpret(snapshot);
  const url = process.env.ANALYSIS_LLM_URL;
  const key = process.env.ANALYSIS_LLM_KEY;
  const model = interpretModel();
  let content: InterpretContent = det;
  let source: "llm" | "deterministic" = "deterministic";
  if (url && key) {
    const parsed = await callDeepSeekInterpret(buildInterpretPayload(snapshot, model), url, key);
    if (parsed) {
      content = mergeInterpretContent(parsed, det, snapshot);
      source = "llm";
    }
  }
  return { row: await persistInterpretation(content, snapshot, source, model), source };
}
