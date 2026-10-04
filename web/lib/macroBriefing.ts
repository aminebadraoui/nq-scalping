/* ------------------------------------------------------------------ *
 * Macro briefing — the orchestrator behind the AI briefing card.
 *
 * DISPLAY-ONLY, like the rest of the macro layer: this module is
 * imported ONLY by /api/briefing and scripts/macroBriefing.ts. The
 * signal engine never sees it.
 *
 * Pipeline: warm GEX → getMacroContext() (the same macro sources the
 * panels show) → read the live NQ session from Neon (candles_1m,
 * written minute-by-minute by the dashboard's LIVE_WRITE) → build the
 * snapshot → DeepSeek JSON-mode call → structured BriefingContent →
 * one row in `macro_briefings`. Any failure degrades to the
 * deterministic renderer in lib/briefingText.ts — the card is never
 * blank.
 *
 * Env: ANALYSIS_LLM_URL + ANALYSIS_LLM_KEY (same keys as the nightly
 * insights job); BRIEFING_LLM_MODEL overrides the model
 * (default deepseek-v4-pro).
 * ------------------------------------------------------------------ */

import { getMacroContext } from "./macroFeed";
import { dbEnabled, getDb } from "./gcdb";
import { sessionDayOf } from "./times";
import { realizedDailyBandPct, impliedFfr, eventEpoch, daysAway, etNow } from "./macroFmt";
import { bpDiff, spread210, spread103m, real10y, breakeven10y } from "./bonds";
import { marketOpenAt } from "./marketHours";
import { getOptionsFeed } from "./optionsFeed";
import {
  buildBriefingPayload,
  enforceHeadlineBias,
  parseBriefingContent,
  renderDeterministicBriefing,
  systemVerdictOf,
  type BriefingContent,
  type BriefingKind,
  type BriefingSnapshot,
  type BriefingSource,
  type SnapshotLevel,
  type SnapshotLine,
} from "./briefingText";

/* ---------------------------------------------------------------- *
 * persistence
 * ---------------------------------------------------------------- */

export const SCHEMA_SQL = `
create table if not exists macro_briefings (
  id bigint generated always as identity primary key,
  kind text not null,
  run_at timestamptz not null default now(),
  generated_at timestamptz not null default now(),
  model text not null default '',
  source text not null default 'deterministic',
  headline text not null default '',
  bias text not null default '',
  regime text not null default '',
  vol text not null default '',
  read jsonb not null default '[]'::jsonb,
  watch_fors jsonb not null default '[]'::jsonb,
  caveats jsonb not null default '[]'::jsonb,
  body text not null default '',
  snapshot jsonb not null default '{}'::jsonb
);
create index if not exists macro_briefings_idx on macro_briefings (kind, run_at desc);
alter table macro_briefings add column if not exists read jsonb not null default '[]'::jsonb;
alter table macro_briefings add column if not exists caveats jsonb not null default '[]'::jsonb;
`;

export type BriefingRow = {
  id: number;
  kind: BriefingKind;
  run_at: string;
  generated_at: string;
  model: string;
  source: BriefingSource;
  headline: string;
  bias: string;
  vol: string;
  read: string[];
  levels: SnapshotLevel[];
  watchFors: string[];
  caveats: string[];
  body: string;
  snapshot: Record<string, unknown>;
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

function rowOf(r: Record<string, unknown>): BriefingRow {
  const read = parseJson<string[]>(r.read, []);
  const bodyLines = String(r.body ?? "")
    .split("\n")
    .map((s) => s.replace(/^#+\s*/, "").replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return {
    id: Number(r.id),
    kind: String(r.kind) as BriefingKind,
    run_at: iso(r.run_at),
    generated_at: iso(r.generated_at),
    model: String(r.model ?? ""),
    source: String(r.source ?? "deterministic") as BriefingSource,
    headline: String(r.headline ?? ""),
    bias: String(r.bias ?? ""),
    vol: String(r.vol ?? ""),
    read: read.length > 0 ? read : bodyLines, // pre-`read` rows fall back to body
    levels: parseJson<SnapshotLevel[]>(r.levels, []),
    watchFors: parseJson<string[]>(r.watch_fors, []),
    caveats: parseJson<string[]>(r.caveats, []),
    body: String(r.body ?? ""),
    snapshot: parseJson<Record<string, unknown>>(r.snapshot, {}),
  };
}

export async function persistBriefing(
  kind: BriefingKind,
  content: BriefingContent,
  snapshot: BriefingSnapshot,
  source: BriefingSource,
  model: string,
): Promise<BriefingRow | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  await db.unsafe(SCHEMA_SQL);
  const rows = await db`
    insert into macro_briefings
      (kind, generated_at, model, source, headline, bias, vol, read, levels, watch_fors, caveats, body, snapshot)
    values (${kind}, now(), ${model}, ${source}, ${content.headline}, ${content.bias},
            ${content.vol}, ${JSON.stringify(content.read)}, ${JSON.stringify(snapshot.nq.levels)},
            ${JSON.stringify(content.watchFors)}, ${JSON.stringify(content.caveats)},
            ${content.read.join("\n")}, ${JSON.stringify(snapshot)})
    returning *`;
  // Neon Free is 512 MB — keep a bounded history
  await db`delete from macro_briefings where run_at < now() - interval '30 days'`;
  return rows.length ? rowOf(rows[0] as unknown as Record<string, unknown>) : null;
}

/* ---------------------------------------------------------------- *
 * NQ tape context from Neon (live-written candles_1m)
 * ---------------------------------------------------------------- */

type CandleRow = { ts: Date; h: number; l: number; c: number | null; v: number; buy: number; sell: number };

type PrevSessionRow = { date: string; h: number; l: number; buy: number; sell: number; c: number | null };

const posPct = (close: number | null, high: number | null, low: number | null): number | null =>
  close != null && high != null && low != null && high > low ? Math.round(((close - low) / (high - low)) * 100) : null;

export async function readNqContext(day: string): Promise<BriefingSnapshot["nq"]> {
  const none: BriefingSnapshot["nq"] = {
    lastClose: null,
    prevSessionClose: null,
    changePct: null,
    sessionHigh: null,
    sessionLow: null,
    cumulativeDelta: null,
    volume: null,
    realizedBandPct: null,
    vixBandPct: null,
    vixBandPts: null,
    bars: null,
    firstBar: null,
    lastBar: null,
    closePosPct: null,
    prevHigh: null,
    prevLow: null,
    prevCumulativeDelta: null,
    prevClosePosPct: null,
    levels: [],
    lines: [],
  };
  if (!dbEnabled()) return none;
  const db = getDb();
  try {
    const rows = (await db`
      select ts, h, l, c, v, buy, sell from candles_1m
      where date = ${day} and session = 'ETH' order by ts asc`) as unknown as CandleRow[];
    // the most recent CLOSED session — always fetched, so a weekend or
    // pre-open briefing can still describe where NQ last traded. Its
    // failure must not kill the current-session read, so it is isolated.
    let prev: PrevSessionRow[] = [];
    try {
      prev = (await db`
        select a.date, d.c, a.h, a.l, a.buy, a.sell from
          (select date, max(h) as h, min(l) as l, sum(buy) as buy, sum(sell) as sell
           from candles_1m where date < ${day} and session = 'ETH' group by date
           order by date desc limit 1) a
        left join lateral
          (select c from candles_1m where date = a.date and session = 'ETH' order by ts desc limit 1) d
          on true`) as unknown as PrevSessionRow[];
    } catch (e) {
      console.warn(`[briefing] prior-session read failed (${String(e)})`);
    }
    const p = prev[0];
    const prevHigh = p && Number.isFinite(Number(p.h)) ? Number(p.h) : null;
    const prevLow = p && Number.isFinite(Number(p.l)) ? Number(p.l) : null;
    const prevClose = p?.c != null && Number.isFinite(Number(p.c)) ? Number(p.c) : null;
    const prevDelta = p && Number.isFinite(Number(p.buy)) && Number.isFinite(Number(p.sell)) ? Number(p.buy) - Number(p.sell) : null;

    if (rows.length === 0) {
      // no live bars for the current session — describe the prior session
      return {
        ...none,
        prevSessionClose: prevClose,
        prevHigh,
        prevLow,
        prevCumulativeDelta: prevDelta,
        prevClosePosPct: posPct(prevClose, prevHigh, prevLow),
      };
    }

    const closes = rows.map((r) => r.c).filter((c): c is number => c != null && Number.isFinite(c));
    const lastClose = closes.length ? closes[closes.length - 1] : null;
    const sessionHigh = Math.max(...rows.map((r) => Number(r.h)));
    const sessionLow = Math.min(...rows.map((r) => Number(r.l)));
    const changePct = lastClose != null && prevClose != null && prevClose > 0 ? Math.round(((lastClose - prevClose) / prevClose) * 10000) / 100 : null;
    return {
      ...none,
      lastClose,
      prevSessionClose: prevClose,
      changePct,
      sessionHigh,
      sessionLow,
      cumulativeDelta: rows.reduce((s, r) => s + Number(r.buy) - Number(r.sell), 0),
      volume: rows.reduce((s, r) => s + Number(r.v), 0),
      realizedBandPct: realizedDailyBandPct(closes.map((c) => ({ c })), 30),
      bars: rows.length,
      firstBar: rows[0].ts instanceof Date ? rows[0].ts.toISOString() : String(rows[0].ts),
      lastBar: rows[rows.length - 1].ts instanceof Date ? rows[rows.length - 1].ts.toISOString() : String(rows[rows.length - 1].ts),
      closePosPct: posPct(lastClose, sessionHigh, sessionLow),
      prevHigh,
      prevLow,
      prevCumulativeDelta: prevDelta,
      prevClosePosPct: posPct(prevClose, prevHigh, prevLow),
    };
  } catch (e) {
    console.warn(`[briefing] NQ tape read failed (${String(e)})`);
    return none;
  }
}

/* ---------------------------------------------------------------- *
 * snapshot assembly
 * ---------------------------------------------------------------- */

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

/** best-effort fresh GEX read — the dashboard's singleton is usually
 *  warm; a CLI process boots it and awaits its first refresh */
async function warmGex(): Promise<void> {
  try {
    const of = getOptionsFeed();
    if (!of.snapshot()) await of.refresh();
  } catch {
    /* GEX degrades to null — never block the briefing on it */
  }
}

export async function buildBriefingSnapshot(kind: BriefingKind): Promise<BriefingSnapshot> {
  await warmGex();
  const ctx = await getMacroContext();
  const now = etNow();
  const sessionDay = sessionDayOf(Date.now());
  const nq = await readNqContext(sessionDay);
  const vix = ctx.watch?.vix ?? null;
  if (nq.lastClose != null && vix?.rangePct != null) {
    nq.vixBandPct = vix.rangePct;
    nq.vixBandPts = Math.round((vix.rangePct / 100) * nq.lastClose * 10) / 10;
  }

  /* ---- key levels as NQ PRICES. GEX arrives in QQQ points — convert
   *      with the live spot ratio so the card never shows QQQ strikes ---- */
  const nqPrice = nq.lastClose ?? nq.prevSessionClose ?? null;
  const gexRaw = ctx.watch?.gex ?? null;
  const nqFmt = (v: number | null): string | null =>
    v != null && Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : null;
  const levels: SnapshotLevel[] = [];
  const lines: SnapshotLine[] = [];
  if (nqPrice != null && gexRaw?.spot != null && gexRaw.spot > 0) {
    const mult = nqPrice / gexRaw.spot;
    const flipNq = gexRaw.flip != null ? gexRaw.flip * mult : null;
    const callNq = gexRaw.callWall != null ? gexRaw.callWall * mult : null;
    const putNq = gexRaw.putWall != null ? gexRaw.putWall * mult : null;
    if (flipNq != null) {
      levels.push({ label: "GEX flip", value: nqFmt(flipNq)!, note: "below it dealers sell into weakness — dips accelerate" });
      lines.push({ label: "GEX flip", price: Math.round(flipNq * 100) / 100, tone: "flip" });
    }
    if (callNq != null) {
      levels.push({ label: "call wall", value: nqFmt(callNq)!, note: "overhead gamma — the magnet that caps rallies" });
      lines.push({ label: "call wall", price: Math.round(callNq * 100) / 100, tone: "call wall" });
    }
    if (putNq != null) {
      levels.push({ label: "put wall", value: nqFmt(putNq)!, note: "support gamma — the floor that slows selloffs" });
      lines.push({ label: "put wall", price: Math.round(putNq * 100) / 100, tone: "put wall" });
    }
  }
  const activeHigh = nq.sessionHigh ?? nq.prevHigh ?? null;
  const activeLow = nq.sessionLow ?? nq.prevLow ?? null;
  if (activeHigh != null) {
    levels.push({ label: nq.sessionHigh != null ? "session high" : "prior high", value: nqFmt(activeHigh)!, note: "clearing it confirms the bid" });
    lines.push({ label: nq.sessionHigh != null ? "session high" : "prior high", price: Math.round(activeHigh * 100) / 100, tone: "high" });
  }
  if (activeLow != null) {
    levels.push({ label: nq.sessionLow != null ? "session low" : "prior low", value: nqFmt(activeLow)!, note: "losing it ends the read" });
    lines.push({ label: nq.sessionLow != null ? "session low" : "prior low", price: Math.round(activeLow * 100) / 100, tone: "low" });
  }
  if (nq.vixBandPts != null && nqPrice != null) {
    levels.push({ label: "VIX 1σ", value: `±${nq.vixBandPts.toFixed(0)}`, note: `daily expected range around ${nqFmt(nqPrice)}` });
    lines.push({ label: "VIX 1σ hi", price: Math.round((nqPrice + nq.vixBandPts) * 100) / 100, tone: "band" });
    lines.push({ label: "VIX 1σ lo", price: Math.round((nqPrice - nq.vixBandPts) * 100) / 100, tone: "band" });
  }
  nq.levels = levels;
  nq.lines = lines;

  /* ---- rates ---- */
  let rates: BriefingSnapshot["rates"] = null;
  const bondsData = ctx.bonds.data;
  if (bondsData?.latest) {
    const cur = bondsData.latest;
    const prev = bondsData.curve[1] ?? null;
    const ff = ctx.watch?.quotes.find((q) => q.symbol === "@FF.1")?.value ?? null;
    rates = {
      y2: cur.y2,
      y10: cur.y10,
      y30: cur.y30,
      curveDate: bondsData.asOf,
      y10ChangeBps: prev ? bpDiff(cur.y10, prev.y10) : null,
      spread210: spread210(cur),
      spread103m: spread103m(cur),
      breakeven10y: breakeven10y(cur, bondsData.real),
      real10y: real10y(cur, bondsData.real),
      effr: bondsData.effr,
      intraday: ctx.bonds.intraday ? { y2: ctx.bonds.intraday.y2, y10: ctx.bonds.intraday.y10, asOf: ctx.bonds.intraday.asOf } : null,
      impliedFfr: impliedFfr(ff),
    };
  }

  /* ---- news ---- */
  const newsItems = (ctx.news.data?.days ?? []).flatMap((d) => d.items);
  const upcomingNews = newsItems
    .filter((i) => !i.released)
    .sort((a, b) => eventEpoch(a) - eventEpoch(b));
  const news = {
    source: ctx.news.data?.source ?? null,
    fetchedAt: ctx.news.fetchedAt ?? null,
    today: newsItems
      .filter((i) => i.day === now.day)
      .map((i) => ({ day: i.day, timeET: i.timeET, title: i.title, impact: i.impact, forecast: i.forecast, previous: i.previous, released: i.released })),
    upcoming: upcomingNews
      .filter((i) => i.day !== now.day)
      .slice(0, 6)
      .map((i) => ({ day: i.day, timeET: i.timeET, title: i.title, impact: i.impact, forecast: i.forecast, previous: i.previous, released: false })),
  };

  /* ---- earnings ---- */
  const earnUp = (ctx.earnings.data?.upcoming ?? [])
    .filter((r) => r.nextDate != null && daysAway(r.nextDate, now.day) >= 0)
    .sort((a, b) => (a.nextDate! < b.nextDate! ? -1 : a.nextDate! > b.nextDate! ? 1 : 0));
  const earnItem = (r: (typeof earnUp)[number]) => ({
    symbol: r.symbol,
    nextDate: r.nextDate,
    nextTime: r.nextTime,
    nextEpsEst: r.nextEpsEst != null && Number.isFinite(Number(r.nextEpsEst)) ? Number(r.nextEpsEst) : null,
    nextEstimated: !!r.nextEstimated,
  });
  const earnings = {
    provider: ctx.earnings.data?.provider ?? null,
    asOf: ctx.earnings.data?.asOf ?? null,
    today: earnUp.filter((r) => daysAway(r.nextDate!, now.day) === 0).map(earnItem),
    upcoming: earnUp
      .filter((r) => daysAway(r.nextDate!, now.day) > 0)
      .slice(0, 6)
      .map(earnItem),
  };

  /* ---- watch ---- */
  const w = ctx.watch;
  const gex = w?.gex;
  const fred = w?.fred;
  const watch = {
    quotesAt: w?.quotesAt ?? null,
    quotes: (w?.quotes ?? []).map((q) => ({ symbol: q.symbol, label: q.label, value: q.value, changePct: q.changePct })),
    vix: vix ? { level: vix.level, pct1y: vix.pct1y, rangePct: vix.rangePct, at: vix.at } : null,
    gex: gex
      ? {
          regime: gex.regime,
          spot: gex.spot != null && Number.isFinite(gex.spot) ? gex.spot : null,
          flip: gex.flip != null && Number.isFinite(gex.flip) ? gex.flip : null,
          callWall: gex.callWall != null && Number.isFinite(gex.callWall) ? gex.callWall : null,
          putWall: gex.putWall != null && Number.isFinite(gex.putWall) ? gex.putWall : null,
          unit: "QQQ points" as const,
        }
      : null,
    htf: w?.htf ? { daily: w.htf.daily, weekly: w.htf.weekly, at: w.htf.at } : null,
    fred: fred
      ? {
          hyOasPct: fred.hyOas?.value ?? null,
          hyOasDelta: fred.hyOas?.delta ?? null,
          walclT: fred.walcl?.value != null ? Math.round((fred.walcl.value / 1e12) * 100) / 100 : null,
          walclDeltaT: fred.walcl?.delta != null ? Math.round((fred.walcl.delta / 1e12) * 100) / 100 : null,
          rrpB: fred.rrp?.value != null ? Math.round(fred.rrp.value / 1e9) : null,
          tgaB: fred.tga?.value != null ? Math.round(fred.tga.value / 1e9) : null,
          at: fred.at,
        }
      : null,
    cot: w?.cot ? { netPctOi: w.cot.netPctOi, pct52w: w.cot.pct52w, asOf: w.cot.asOf } : null,
    calendar: w?.calendar ?? null,
    errors: w?.errors ?? [],
  };

  const snapshot: BriefingSnapshot = {
    kind,
    generatedAt: new Date().toISOString(),
    etDay: now.day,
    etClock: etClockNow(),
    marketOpen: marketOpenAt(Date.now()),
    sessionDay,
    nq,
    rates,
    news,
    earnings,
    watch,
    systemVerdict: { bias: "", vol: "", evidence: [], confidencePct: null }, // filled below (needs the whole snapshot)
    staleness: {
      bonds: { ok: ctx.bonds.ok, stale: ctx.bonds.stale, fetchedAt: ctx.bonds.fetchedAt ?? null, error: ctx.bonds.error ?? null },
      news: { ok: ctx.news.ok, stale: ctx.news.stale, fetchedAt: ctx.news.fetchedAt ?? null, error: ctx.news.error ?? null },
      earnings: { ok: ctx.earnings.ok, stale: ctx.earnings.stale, fetchedAt: ctx.earnings.fetchedAt ?? null, error: ctx.earnings.error ?? null },
    },
  };
  snapshot.systemVerdict = systemVerdictOf(snapshot);
  return snapshot;
}

/* ---------------------------------------------------------------- *
 * DeepSeek call + generation
 * ---------------------------------------------------------------- */

export function briefingModel(): string {
  return process.env.BRIEFING_LLM_MODEL ?? "deepseek-v4-pro";
}

export async function callDeepSeekBriefing(
  payload: ReturnType<typeof buildBriefingPayload>,
  url: string,
  key: string,
): Promise<BriefingContent | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.warn(`[briefing] LLM ${res.status} — deterministic fallback`);
      return null;
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
    const raw = j.choices?.[0]?.message?.content;
    const parsed = parseBriefingContent(raw);
    if (!parsed) {
      console.warn(`[briefing] LLM returned unparseable content (${String(raw ?? "").slice(0, 200)}) — deterministic fallback`);
    }
    return parsed;
  } catch (e) {
    console.warn(`[briefing] LLM failed (${String(e)}) — deterministic fallback`);
    return null;
  }
}

/** the full generation path, shared by the CLI and the refresh route.
 *  Never throws: LLM failure degrades to the deterministic renderer,
 *  DB failure returns null (the card shows its own error state).
 *  The bias + vol are ALWAYS the code-decided systemVerdict — the model
 *  only writes prose around it, so reruns can never flip the verdict. */
export async function generateBriefing(kind: BriefingKind): Promise<{ row: BriefingRow | null; source: BriefingSource }> {
  const snapshot = await buildBriefingSnapshot(kind);
  const url = process.env.ANALYSIS_LLM_URL;
  const key = process.env.ANALYSIS_LLM_KEY;
  const model = briefingModel();
  let content: BriefingContent | null = null;
  if (url && key) {
    content = await callDeepSeekBriefing(buildBriefingPayload(snapshot, model), url, key);
  }
  if (!content) {
    const det = renderDeterministicBriefing(snapshot);
    return { row: await persistBriefing(kind, det, snapshot, "deterministic", model), source: "deterministic" };
  }
  content.bias = snapshot.systemVerdict.bias;
  content.vol = snapshot.systemVerdict.vol;
  content.headline = enforceHeadlineBias(content.headline, content.bias);
  return { row: await persistBriefing(kind, content, snapshot, "llm", model), source: "llm" };
}

/** latest stored row (optionally filtered by kind) */
export async function latestBriefing(kind?: BriefingKind): Promise<BriefingRow | null> {
  if (!dbEnabled()) return null;
  const db = getDb();
  try {
    await db.unsafe(SCHEMA_SQL);
    const rows = kind
      ? (await db`select * from macro_briefings where kind = ${kind} order by run_at desc, id desc limit 1`) as unknown as Record<string, unknown>[]
      : (await db`select * from macro_briefings order by run_at desc, id desc limit 1`) as unknown as Record<string, unknown>[];
    return rows.length ? rowOf(rows[0]) : null;
  } catch (e) {
    console.warn(`[briefing] read failed (${String(e)})`);
    return null;
  }
}
