/* ------------------------------------------------------------------ *
 * MACRO WATCH — the cross-asset/regime/calendar layer researched in
 * docs/data/MACRO_DASHBOARD_USEFULNESS.md and spec'd in
 * docs/data/macro-watch-panel-ui-research.md. DISPLAY-ONLY: this
 * module is imported only by lib/macroFeed.ts (which is imported only
 * by /api/macro) — the signal engine never sees it.
 *
 * Sources (all live-verified Oct 2026, keyless unless noted):
 *   - quotes: ONE CNBC restQuote pipe-batch (.VIX .DXY .SPX .NDX .SOX
 *     SPY RSP SMH QQQ @GC.1 @CL.1 BTC.CB= US10Y US2Y @FF.1), ~20 min
 *     delayed, TTL 60 s
 *   - VIX level/percentiles/term: CBOE daily history CSVs
 *     (VIX_History 1990+, VIX9D_History, VIX3M_History), TTL 6 h
 *   - GEX sign/flip/pin: the existing live CBOE QQQ options feed
 *     (lib/optionsFeed.ts singleton) — zero new requests
 *   - auctions: TreasuryDirect /TA_WS/securities/upcoming (type=Note,
 *     type=Bond), TTL 24 h, hardcoded Q4-2026 coupon fallback
 *   - liquidity: FRED keyless CSV per series (RRPONTSYD, WDTGAL,
 *     WALCL, BAMLH0A0HYM2) — free key not needed for the CSV route;
 *     degrades to null when unreachable, TTL 6 h
 *   - positioning: CFTC COT Socrata (NASDAQ-100 Consolidated,
 *     noncommercial = spec), TTL 24 h
 *   - OPEX + FOMC minutes: computed locally (3rd Friday rule; FOMC
 *     decision + ~21 days, flagged approximate)
 *
 * Pure parsers, unit-tested (tests/macroWatch.test.mjs).
 * ------------------------------------------------------------------ */

import { getOptionsFeed } from "./optionsFeed";
import type { GammaRead } from "./options";
import { NEWS_EVENTS, etDayAndClock } from "./newsGate";
import { htfStructure, type Structure } from "./htfStructure";

export type WatchGroup = "risk" | "rates" | "fx-equities" | "commodities" | "crypto";

export type WatchQuote = {
  symbol: string;
  label: string;
  group: WatchGroup;
  value: number | null;
  change: number | null;
  changePct: number | null;
  /** CNBC timestamp string, e.g. "5:38 PM EDT" */
  asOf: string | null;
};

export type WatchCalendar = {
  opex: { day: string; quad: boolean; days: number } | null;
  auctions: { label: string; day: string; days: number }[];
  fomcMinutes: { day: string; days: number; approx: boolean } | null;
};

export type FredPoint = { day: string; value: number | null; delta: number | null };

/** 5-day daily closes per watch symbol (best-effort — tiles render fine without) */
export type SparkMap = Record<string, number[]>;

export type WatchData = {
  quotes: WatchQuote[];
  quotesAt: string | null;
  vix: {
    level: number | null;
    pct1y: number | null;
    pctAll: number | null;
    rangePct: number | null;
    term9d: number | null;
    term3m: number | null;
    at: string | null;
  };
  gex: (GammaRead & {}) | null;
  sparks: SparkMap;
  /** daily/weekly swing structure from the system's own archive */
  htf: { daily: Structure | null; weekly: Structure | null; at: string | null };
  fred: { hyOas: FredPoint | null; rrp: FredPoint | null; tga: FredPoint | null; walcl: FredPoint | null; at: string | null } | null;
  cot: { net: number | null; netPctOi: number | null; pct52w: number | null; asOf: string | null } | null;
  calendar: WatchCalendar | null;
  errors: string[];
};

/* ---------------- time helpers ------------------------------------- */

export function etToday(): string {
  return etDayAndClock(Date.now()).day;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/* ---------------- CNBC batch parsing ------------------------------- */

type CnbcRow = {
  symbol?: string;
  last?: string;
  change?: string;
  change_pct?: string;
  last_timedate?: string;
};

export const WATCH_QUOTE_CFG: { symbol: string; label: string; group: WatchGroup }[] = [
  { symbol: ".VIX", label: "VIX", group: "risk" },
  { symbol: ".DXY", label: "DXY", group: "fx-equities" },
  { symbol: ".SPX", label: "S&P 500", group: "fx-equities" },
  { symbol: ".NDX", label: "Nasdaq-100", group: "fx-equities" },
  { symbol: ".SOX", label: "SOX semis", group: "fx-equities" },
  { symbol: "SPY", label: "SPY", group: "fx-equities" },
  { symbol: "RSP", label: "RSP eq-wt", group: "fx-equities" },
  { symbol: "SMH", label: "SMH semis", group: "fx-equities" },
  { symbol: "QQQ", label: "QQQ", group: "fx-equities" },
  { symbol: "@GC.1", label: "Gold", group: "commodities" },
  { symbol: "@CL.1", label: "WTI crude", group: "commodities" },
  { symbol: "BTC.CB=", label: "Bitcoin", group: "crypto" },
  { symbol: "US10Y", label: "10Y", group: "rates" },
  { symbol: "US2Y", label: "2Y", group: "rates" },
  { symbol: "@FF.1", label: "Fed Funds fut", group: "rates" },
];

function numOf(v: string | undefined | null): number | null {
  if (v == null || v === "" || v === "undefined") return null;
  const n = Number(String(v).replace(/[%$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseCnbcBatch(json: unknown): WatchQuote[] {
  const j = json as { FormattedQuoteResult?: { FormattedQuote?: CnbcRow[] } };
  const rows = j?.FormattedQuoteResult?.FormattedQuote ?? [];
  const bySym = new Map(rows.map((r) => [r.symbol, r]));
  const out: WatchQuote[] = [];
  for (const cfg of WATCH_QUOTE_CFG) {
    const r = bySym.get(cfg.symbol);
    out.push({
      symbol: cfg.symbol,
      label: cfg.label,
      group: cfg.group,
      value: numOf(r?.last),
      change: numOf(r?.change),
      changePct: numOf(r?.change_pct),
      asOf: r?.last_timedate ?? null,
    });
  }
  return out;
}

/* ---------------- VIX stats ---------------------------------------- */

export function vixStats(csv: string): { level: number | null; pct1y: number | null; pctAll: number | null; at: string | null } {
  const rows: { day: string; close: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < 5 || !/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0])) continue;
    const [m, d, y] = cells[0].split("/").map(Number);
    const v = Number(cells[4]);
    if (!Number.isFinite(v)) continue;
    rows.push({ day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, close: v });
  }
  if (rows.length === 0) return { level: null, pct1y: null, pctAll: null, at: null };
  const last = rows[rows.length - 1];
  const pctOf = (xs: number[]) => {
    const below = xs.filter((v) => v <= last.close).length;
    return Math.round((below / xs.length) * 100);
  };
  return {
    level: last.close,
    pct1y: rows.length >= 10 ? pctOf(rows.slice(-252).map((r) => r.close)) : null,
    pctAll: pctOf(rows.map((r) => r.close)),
    at: last.day,
  };
}

/** rule of 16: daily 1σ expected move in percent */
export function expectedRangePct(vixLevel: number | null): number | null {
  if (vixLevel == null || !Number.isFinite(vixLevel) || vixLevel <= 0) return null;
  return Math.round((vixLevel / 16) * 100) / 100;
}

/* ---------------- calendar (OPEX, auctions, minutes) --------------- */

/** the next 3rd Friday (monthly OPEX); quad witching in Mar/Jun/Sep/Dec */
export function nextOpex(today: string): { day: string; quad: boolean; days: number } | null {
  const [y, m, d] = today.split("-").map(Number);
  for (let delta = 0; delta < 60; delta++) {
    const t = new Date(Date.UTC(y, m - 1, d + delta));
    const dow = t.getUTCDay();
    const dom = t.getUTCDate();
    if (dow === 5 && dom >= 15 && dom <= 21) {
      const day = t.toISOString().slice(0, 10);
      const month = t.getUTCMonth(); // 0-based
      return { day, quad: month === 2 || month === 5 || month === 8 || month === 11, days: delta };
    }
  }
  return null;
}

/** FOMC minutes ≈ 3 weeks after the decision (Fed schedule convention) */
export function nextFomcMinutes(today: string): { day: string; days: number; approx: boolean } | null {
  const fomc = NEWS_EVENTS.filter((e) => e.kind === "fomc").map((e) => e.day);
  const candidates = fomc
    .map((d) => ({ day: addDays(d, 21), days: daysBetween(today, addDays(d, 21)) }))
    .filter((c) => c.days >= 0)
    .sort((a, b) => a.days - b.days);
  return candidates[0] ? { ...candidates[0], approx: true } : null;
}

type TdRow = {
  securityType?: string;
  securityTerm?: string;
  originalSecurityTerm?: string;
  auctionDate?: string;
  tips?: string;
};

/** TreasuryDirect upcoming-securities JSON → auction rows (coupons only).
 *  "9-Year 10-Month" is a reopened 10Y — label from originalSecurityTerm
 *  when present, else normalized from securityTerm. */
export function parseTreasuryDirect(json: unknown, today: string): { label: string; day: string; days: number }[] {
  const rows = (Array.isArray(json) ? (json as TdRow[]) : []).filter((r) => r.auctionDate);
  const out: { label: string; day: string; days: number }[] = [];
  for (const r of rows) {
    const term = r.originalSecurityTerm || r.securityTerm || "";
    const m = /(\d+)-Year/.exec(term);
    if (!m) continue;
    const isTips = String(r.tips).toUpperCase() === "YES" || String(r.tips).toUpperCase() === "Y";
    const label = `${m[1]}Y${isTips ? " TIPS" : ""}`;
    const day = String(r.auctionDate).slice(0, 10);
    const days = daysBetween(today, day);
    if (days < 0) continue;
    out.push({ label, day, days });
  }
  out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}

/** hardcoded Q4-2026 coupon auctions (from the Treasury Tentative
 *  Auction Schedule PDF, extracted 2026-10-03) — the fallback when
 *  TreasuryDirect is unreachable. Refresh each quarter. */
export const AUCTION_FALLBACK_2026Q4: { label: string; day: string }[] = [
  { label: "10Y", day: "2026-10-07" },
  { label: "30Y", day: "2026-10-08" },
  { label: "20Y", day: "2026-10-21" },
  { label: "10Y", day: "2026-11-10" },
  { label: "30Y", day: "2026-11-12" },
  { label: "20Y", day: "2026-11-18" },
  { label: "10Y", day: "2026-12-08" },
  { label: "30Y", day: "2026-12-10" },
  { label: "20Y", day: "2026-12-23" },
];

/* ---------------- FRED keyless CSV --------------------------------- */

export function parseFredCsv(text: string): { day: string; value: number | null }[] {
  const rows: { day: string; value: number | null }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("DATE")) continue;
    const [day, value] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) continue;
    rows.push({ day, value: numOf(value) });
  }
  return rows;
}

/** latest value + change vs `lookback` rows earlier (FRED CSV = oldest first) */
export function fredPoint(text: string, lookback: number): FredPoint | null {
  const rows = parseFredCsv(text);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 1 - lookback];
  const delta = prev?.value != null && last.value != null ? Math.round((last.value - prev.value) * 100) / 100 : null;
  return { day: last.day, value: last.value, delta };
}

/* ---------------- Yahoo spark parsing ------------------------------ */

const SPARK_SYMBOLS: Record<string, string> = {
  ".VIX": "^VIX",
  ".DXY": "DX-Y.NYB",
  ".SPX": "^GSPC",
  ".NDX": "^NDX",
  ".SOX": "^SOX",
  "SPY": "SPY",
  "RSP": "RSP",
  "SMH": "SMH",
  "QQQ": "QQQ",
  "@GC.1": "GC=F",
  "@CL.1": "CL=F",
  "BTC.CB=": "BTC-USD",
  "US10Y": "^TNX",
};

export function parseSparks(json: unknown): SparkMap {
  const j = json as {
    spark?: {
      result?: { symbol?: string; response?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] }[];
    };
  };
  const out: SparkMap = {};
  for (const r of j?.spark?.result ?? []) {
    const closes = r.response?.[0]?.indicators?.quote?.[0]?.close;
    if (!r.symbol || !closes) continue;
    const pts = closes.filter((v): v is number => v != null && Number.isFinite(v));
    if (pts.length >= 2) out[r.symbol] = pts;
  }
  return out;
}

async function fetchSparks(): Promise<SparkMap> {
  const syms = Object.values(SPARK_SYMBOLS).join(",");
  const text = await fetchText(
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(syms)}&range=5d&interval=1d`,
    15_000,
  );
  const map = parseSparks(JSON.parse(text));
  const out: SparkMap = {};
  for (const [ours, y] of Object.entries(SPARK_SYMBOLS)) {
    if (map[y]) out[ours] = map[y];
  }
  return out;
}

/* ---------------- HTF structure (own archive) ---------------------- */

export async function fetchHtf(): Promise<{ daily: Structure | null; weekly: Structure | null; at: string | null }> {
  const { listDatasets, extractFootprint } = await import("./gcdata");
  const ds = await listDatasets();
  const dates = (ds ?? [])
    .map((x) => x.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .slice(-65); // ≈ one quarter of trading days
  if (dates.length < 8) throw new Error(`archive too thin: ${dates.length} sessions`);

  const minutes: { t: string; high: number; low: number }[] = [];
  for (const d of dates) {
    try {
      const fp = await extractFootprint(d, "RTH", undefined, undefined);
      if (!fp) continue;
      // footprint minutes carry only "HH:mm" in t; the date rides in m.d
      for (const m of fp.minutes) minutes.push({ t: `${m.d ?? d}T${m.t}:00`, high: m.high, low: m.low });
    } catch {
      /* one bad session shouldn't kill the read */
    }
  }
  if (minutes.length < 500) throw new Error(`HTF minutes too few: ${minutes.length}`);
  const s = htfStructure(minutes);
  return { daily: s.daily, weekly: s.weekly, at: dates[dates.length - 1] };
}

/* ---------------- COT parsing -------------------------------------- */

type CotRow = {
  report_date_as_yyyy_mm_dd?: string;
  noncomm_positions_long_all?: string;
  noncomm_positions_short_all?: string;
  open_interest_all?: string;
};

export function parseCot(json: unknown): { net: number | null; netPctOi: number | null; pct52w: number | null; asOf: string | null } {
  const rows = (Array.isArray(json) ? (json as CotRow[]) : []).filter((r) => r.report_date_as_yyyy_mm_dd);
  if (rows.length === 0) return { net: null, netPctOi: null, pct52w: null, asOf: null };
  const nets = rows.map((r) => {
    const l = numOf(r.noncomm_positions_long_all);
    const s = numOf(r.noncomm_positions_short_all);
    return l != null && s != null ? l - s : null;
  });
  const last = nets[0];
  const oi = numOf(rows[0].open_interest_all);
  const netPctOi = last != null && oi != null && oi > 0 ? Math.round((last / oi) * 1000) / 10 : null;
  const hist = nets.filter((n): n is number => n != null);
  const pct52w = last != null && hist.length > 1 ? Math.round((hist.filter((n) => n <= last).length / hist.length) * 100) : null;
  return {
    net: last,
    netPctOi,
    pct52w,
    asOf: String(rows[0].report_date_as_yyyy_mm_dd).slice(0, 10),
  };
}

/* ---------------- fetchers (server-side) --------------------------- */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CNBC_URL =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" +
  WATCH_QUOTE_CFG.map((c) => encodeURIComponent(c.symbol)).join("%7C") +
  "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";

const CBOE_HISTORY = (f: string) => `https://cdn.cboe.com/api/global/us_indices/daily_prices/${f}`;
const TD_UPCOMING = (type: string) =>
  `https://www.treasurydirect.gov/TA_WS/securities/upcoming?type=${type}&daysInFuture=60`;
const FRED_CSV = (id: string) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
const COT_URL =
  "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$order=report_date_as_yyyy_mm_dd%20DESC&$limit=52&$where=" +
  encodeURIComponent('market_and_exchange_names like "%NASDAQ-100 Consolidated%"');

async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/csv,text/plain,application/json,*/*" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/* tiny TTL cache with in-flight dedup (the /api/gc pattern) */
type Entry = { at: number; value: unknown };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      inflight.delete(key);
      return value;
    },
    (err) => {
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

type CoinbaseSpot = { data?: { amount?: string; base?: string; currency?: string } };

export function parseCoinbaseBtc(json: unknown): number | null {
  const j = json as CoinbaseSpot;
  if (j?.data?.currency !== "USD") return null;
  const n = numOf(j.data.amount);
  return n != null && n > 0 ? n : null;
}

const COINBASE_BTC = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

async function fetchQuotes(): Promise<{ quotes: WatchQuote[]; at: string }> {
  const text = await fetchText(CNBC_URL, 15_000);
  const quotes = parseCnbcBatch(JSON.parse(text));
  if (quotes.every((q) => q.value == null)) throw new Error("CNBC batch empty");

  // upgrade BTC to real-time Coinbase spot (keyless); keep CNBC's Δ for the day change
  try {
    const btc = parseCoinbaseBtc(JSON.parse(await fetchText(COINBASE_BTC, 8_000)));
    const q = quotes.find((x) => x.symbol === "BTC.CB=");
    if (btc != null && q) {
      q.value = btc;
      q.asOf = "coinbase · real-time";
    }
  } catch {
    /* CNBC value stays */
  }
  return { quotes, at: new Date().toISOString() };
}

async function fetchVix(): Promise<WatchData["vix"]> {
  const [hist, v9, v3] = await Promise.all([
    fetchText(CBOE_HISTORY("VIX_History.csv")),
    fetchText(CBOE_HISTORY("VIX9D_History.csv")).catch(() => ""),
    fetchText(CBOE_HISTORY("VIX3M_History.csv")).catch(() => ""),
  ]);
  const s = vixStats(hist);
  return {
    level: s.level,
    pct1y: s.pct1y,
    pctAll: s.pctAll,
    rangePct: expectedRangePct(s.level),
    term9d: v9 ? vixStats(v9).level : null,
    term3m: v3 ? vixStats(v3).level : null,
    at: s.at,
  };
}

async function fetchFred(): Promise<WatchData["fred"]> {
  const [hy, rrp, tga, walcl] = await Promise.all([
    fetchText(FRED_CSV("BAMLH0A0HYM2")).then((t) => fredPoint(t, 60)).catch(() => null),
    fetchText(FRED_CSV("RRPONTSYD")).then((t) => fredPoint(t, 13)).catch(() => null),
    fetchText(FRED_CSV("WDTGAL")).then((t) => fredPoint(t, 13)).catch(() => null),
    fetchText(FRED_CSV("WALCL")).then((t) => fredPoint(t, 2)).catch(() => null),
  ]);
  if (!hy && !rrp && !tga && !walcl) throw new Error("FRED unreachable (all series failed)");
  return { hyOas: hy, rrp, tga, walcl, at: new Date().toISOString() };
}

async function fetchCot(): Promise<WatchData["cot"]> {
  const text = await fetchText(COT_URL, 20_000);
  return parseCot(JSON.parse(text));
}

async function fetchCalendar(): Promise<WatchCalendar> {
  const today = etToday();
  let auctions: { label: string; day: string; days: number }[] = [];
  try {
    const [notes, bonds] = await Promise.all([
      fetchText(TD_UPCOMING("Note")).then((t) => JSON.parse(t)),
      fetchText(TD_UPCOMING("Bond")).then((t) => JSON.parse(t)),
    ]);
    auctions = [...parseTreasuryDirect(notes, today), ...parseTreasuryDirect(bonds, today)].sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
    );
  } catch {
    auctions = AUCTION_FALLBACK_2026Q4.map((a) => ({ ...a, days: daysBetween(today, a.day) })).filter((a) => a.days >= 0);
  }
  const opex = nextOpex(today);
  const fomcMinutes = nextFomcMinutes(today);
  return { opex, auctions, fomcMinutes };
}

/** aggregate — never throws; every piece degrades to null + error note */
export async function getMacroWatch(): Promise<WatchData> {
  const errors: string[] = [];
  const piece = async <T>(key: string, ttl: number, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await cached(key, ttl, fn);
    } catch (e) {
      errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  const [quotes, vix, fred, cot, calendar, sparks, htf] = await Promise.all([
    piece<{ quotes: WatchQuote[]; at: string | null }>("mw-quotes", 60_000, fetchQuotes, { quotes: [], at: null }),
    piece("mw-vix", 6 * 3600_000, fetchVix, { level: null, pct1y: null, pctAll: null, rangePct: null, term9d: null, term3m: null, at: null }),
    piece("mw-fred", 6 * 3600_000, fetchFred, null),
    piece("mw-cot", 24 * 3600_000, fetchCot, { net: null, netPctOi: null, pct52w: null, asOf: null }),
    piece("mw-calendar-v2", 24 * 3600_000, fetchCalendar, { opex: null, auctions: [], fomcMinutes: null }),
    piece("mw-sparks", 3600_000, fetchSparks, {} as SparkMap),
    piece("mw-htf", 6 * 3600_000, fetchHtf, { daily: null, weekly: null, at: null }),
  ]);

  return {
    quotes: quotes.quotes,
    quotesAt: quotes.at,
    vix,
    gex: getOptionsFeed().snapshot(),
    sparks,
    htf,
    fred,
    cot,
    calendar,
    errors,
  };
}
