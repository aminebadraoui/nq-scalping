/* ------------------------------------------------------------------ *
 * Server-side macro-context fetcher: bonds, weekly US news calendar,
 * NQ earnings (full-quarter NDX view). DISPLAY-ONLY — the signal engine never imports this
 * module, so none of it can influence signals.
 *
 * Every source is fetched from the dashboard's own API route
 * (/api/macro) with an in-process TTL cache: the dashboard polls the
 * route, the route re-hits the upstreams at most once per TTL window.
 *   - bonds: official .gov feeds, no keys (TTL 1 h; the curve prints
 *     once a day ~15:30 ET)
 *   - news: calendar feed (TTL 10 min so Actual/Forecast/Previous stay
 *     current through the week)
 *   - earnings: full-NDX quarter calendar (TTL 6 h)
 *
 * Honest bounds: every external feed can fail or drift — each source
 * degrades to a cached copy (in-process), and the news panel degrades
 * further to the STATIC high-impact calendar in lib/newsCalendar.ts.
 * Errors surface in the payload as `error`, never as a blank panel.
 * ------------------------------------------------------------------ */

import { buildBondsData, parseCnbcQuotes, type BondsData, type IntradayCurve } from "./bonds";
import { fetchNewsWeek, staticWeek, etNow, hasUpcoming, type NewsWeek } from "./newsCalendar";
import { fetchNdxQuarter, type QuarterData } from "./earnings";
import { getMacroWatch, type WatchData } from "./macroWatch";

export type MacroSource = {
  ok: boolean;
  /** upstream fetch error, if any (panel shows stale + this) */
  error?: string;
  /** ISO time of the last successful upstream fetch */
  fetchedAt?: string;
  /** true when serving a cached copy that is older than its TTL */
  stale: boolean;
};

export type MacroContext = {
  bonds: MacroSource & { data: BondsData | null; intraday: IntradayCurve | null };
  news: MacroSource & { data: NewsWeek | null };
  earnings: MacroSource & { data: QuarterData | null };
  /** macro watch (cross-asset/regime/calendar) — best-effort, never null */
  watch: WatchData | null;
};

/* ---------------------------------------------------------------- *
 * tiny TTL cache with in-flight dedup (the /api/gc pattern)
 * ---------------------------------------------------------------- */
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

/* ---------------------------------------------------------------- *
 * generic upstream fetch
 * ---------------------------------------------------------------- */
export async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; NQDashboard/1.0)",
      Accept: "text/csv,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
    // never let Next's data cache serve these; the in-process TTL below owns freshness
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/* ---------------------------------------------------------------- *
 * bonds — Treasury par curve + real curve + NY Fed EFFR
 * ---------------------------------------------------------------- */
const BONDS_TTL = 60 * 60 * 1000; // 1 h

const CURVE_CSV = (year: number, type: string) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;

const EFFR_URL = (year: number) =>
  `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${year}-01-01&endDate=${year}-12-31`;

const INTRADAY_TTL = 2 * 60 * 1000; // 2 min — the CNBC feed is ~20 min delayed anyway

const CNBC_CURVE_URL =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US1M%7CUS3M%7CUS6M%7CUS2Y%7CUS5Y%7CUS10Y%7CUS30Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";

async function fetchBondsUpstream(): Promise<{ data: BondsData; fetchedAt: string }> {
  const year = new Date().getUTCFullYear();
  const [nominal, real, effr] = await Promise.all([
    fetchText(CURVE_CSV(year, "daily_treasury_yield_curve")).catch(() => ""),
    fetchText(CURVE_CSV(year, "daily_treasury_real_yield_curve")).catch(() => ""),
    fetchText(EFFR_URL(year))
      .then((t) => {
        const j = JSON.parse(t) as { refRates?: { effectiveDate: string; percentRate?: number; targetRateFrom?: number; targetRateTo?: number }[] };
        const last = j.refRates?.[0];
        return last
          ? { date: last.effectiveDate, rate: last.percentRate ?? null, targetFrom: last.targetRateFrom ?? null, targetTo: last.targetRateTo ?? null }
          : null;
      })
      .catch(() => null),
  ]);
  if (!nominal) throw new Error("treasury curve feed empty");
  return { data: buildBondsData(nominal, real, effr), fetchedAt: new Date().toISOString() };
}

export async function getBonds(): Promise<MacroSource & { data: BondsData | null; intraday: IntradayCurve | null }> {
  const key = "bonds";
  const hit = cache.get(key);
  let data: BondsData | null = null;
  let fetchedAt: string | undefined;
  let ok = false;
  let error: string | undefined;
  try {
    const fresh = await cached(key, BONDS_TTL, fetchBondsUpstream);
    data = fresh.data;
    fetchedAt = fresh.fetchedAt;
    ok = true;
  } catch (e) {
    // serve the last good copy instead of a blank panel
    error = e instanceof Error ? e.message : String(e);
    data = (hit?.value as { data: BondsData } | undefined)?.data ?? null;
    fetchedAt = hit ? new Date(hit.at).toISOString() : undefined;
  }
  /* delayed intraday garnish — short TTL, failure is fine */
  let intraday: IntradayCurve | null = null;
  try {
    intraday = await cached("bonds-intraday", INTRADAY_TTL, async () => {
      const text = await fetchText(CNBC_CURVE_URL);
      return parseCnbcQuotes(JSON.parse(text));
    });
  } catch {
    intraday = null;
  }
  return { ok, error, data, fetchedAt, intraday, stale: !ok && !!hit };
}

/* ---------------------------------------------------------------- *
 * news — weekly US calendar
 * ---------------------------------------------------------------- */
const NEWS_TTL = 10 * 60 * 1000; // 10 min

export async function getNews(): Promise<MacroSource & { data: NewsWeek | null }> {
  const key = "news";
  const hit = cache.get(key);
  try {
    const fresh = await cached(key, NEWS_TTL, fetchNewsWeek);
    return { ok: true, data: fresh.data, fetchedAt: fresh.fetchedAt, stale: false };
  } catch (e) {
    // a stale cache is only useful while it still has upcoming events —
    // a fully-released cached week (Saturday) is worse than the static
    // calendar, which knows the next Fed/BLS week
    const cachedWeek = (hit?.value as { data: NewsWeek } | undefined)?.data ?? null;
    const keep = cachedWeek != null && hasUpcoming(cachedWeek);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      data: keep ? cachedWeek : staticWeek(etNow()),
      fetchedAt: keep && hit ? new Date(hit.at).toISOString() : undefined,
      stale: keep && !!hit,
    };
  }
}

/* ---------------------------------------------------------------- *
 * earnings — NQ majors
 * ---------------------------------------------------------------- */
const EARNINGS_TTL = 6 * 60 * 60 * 1000; // 6 h

export async function getEarnings(): Promise<MacroSource & { data: QuarterData | null }> {
  const key = "earnings-quarter-v4";
  const hit = cache.get(key);
  try {
    const fresh = await cached(key, EARNINGS_TTL, fetchNdxQuarter);
    return { ok: true, data: fresh, fetchedAt: new Date().toISOString(), stale: false };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      data: (hit?.value as { data: QuarterData } | undefined)?.data ?? null,
      fetchedAt: hit ? new Date(hit.at).toISOString() : undefined,
      stale: !!hit,
    };
  }
}

/* ---------------------------------------------------------------- *
 * aggregate
 * ---------------------------------------------------------------- */
export async function getMacroContext(): Promise<MacroContext> {
  const [bonds, news, earnings, watch] = await Promise.all([getBonds(), getNews(), getEarnings(), getMacroWatch()]);
  return { bonds, news, earnings, watch };
}
