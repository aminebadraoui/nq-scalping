/* ------------------------------------------------------------------ *
 * Earnings calendar for the major Nasdaq-100 names — DISPLAY-ONLY
 * macro context (the signal engine never imports this).
 *
 * Source: Nasdaq's public JSON API (keyless, verified live Oct 2026):
 *   - last report:   /api/company/{SYMBOL}/earnings-surprise
 *                    → earningsSurpriseTable.rows[]: fiscalQtrEnd,
 *                      dateReported, eps (actual), consensusForecast,
 *                      percentageSurprise — the most recent row is the
 *                      latest report.
 *   - next report:   /api/calendar/earnings?date=YYYY-MM-DD
 *                    → data.rows[]: symbol, name, time
 *                      (time-pre-market / time-after-hours /
 *                      time-not-supplied), fiscalQuarterEnding,
 *                      epsForecast, lastYearRptDt. The forward calendar
 *                      is scanned day-by-day (max 60 days) until every
 *                      watched ticker has a confirmed date.
 * When no confirmed date exists yet the panel shows an ESTIMATE:
 * last year's report date + 1 year, marked as estimated.
 *
 * Politeness: ~60 small requests per refresh with 250 ms spacing, one
 * refresh per 6 h TTL (macroFeed) — well inside Nasdaq's tolerance.
 * Per-request failures degrade to nulls for that row, never the whole
 * panel.
 *
 * Pure parsers, unit-tested (tests/earnings.test.mjs).
 * ------------------------------------------------------------------ */

export type NextTime = "bmo" | "amc" | null;

export type EarningsRow = {
  symbol: string;
  name: string;
  /* last report */
  lastDate: string | null; // "YYYY-MM-DD"
  lastFiscalQ: string | null;
  lastEps: number | null;
  lastConsensus: number | null;
  surprisePct: number | null;
  /* next report */
  nextDate: string | null; // "YYYY-MM-DD", null = unknown
  nextEstimated: boolean; // date is last-year+1y heuristic, not confirmed
  nextTime: NextTime;
  nextFiscalQ: string | null;
  nextEpsEst: number | null;
};

export type EarningsData = {
  asOf: string;
  /** which upstream produced this payload (shown on the panel) */
  provider: "nasdaq" | "finnhub";
  rows: EarningsRow[];
};

/** the watched universe: Nasdaq-100 top-30 by QQQ weight (Oct 2, 2026) */
export const NQ_MAJOR: { symbol: string; name: string }[] = [
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "MU", name: "Micron" },
  { symbol: "AMD", name: "AMD" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "GOOGL", name: "Alphabet A" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "GOOG", name: "Alphabet C" },
  { symbol: "SPCX", name: "SpaceX" },
  { symbol: "INTC", name: "Intel" },
  { symbol: "AVGO", name: "Broadcom" },
  { symbol: "WMT", name: "Walmart" },
  { symbol: "PLTR", name: "Palantir" },
  { symbol: "CSCO", name: "Cisco" },
  { symbol: "LRCX", name: "Lam Research" },
  { symbol: "AMAT", name: "Applied Materials" },
  { symbol: "COST", name: "Costco" },
  { symbol: "PANW", name: "Palo Alto Networks" },
  { symbol: "NFLX", name: "Netflix" },
  { symbol: "CRWD", name: "CrowdStrike" },
  { symbol: "SNDK", name: "SanDisk" },
  { symbol: "TXN", name: "Texas Instruments" },
  { symbol: "ASML", name: "ASML Holding" },
  { symbol: "KLAC", name: "KLA Corp" },
  { symbol: "MRVL", name: "Marvell" },
  { symbol: "LIN", name: "Linde" },
  { symbol: "AMGN", name: "Amgen" },
  { symbol: "ADI", name: "Analog Devices" },
];

/* ---------------- parsing ------------------------------------------ */

function parseUsDate(d: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d.trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function parseMoney(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%]/g, ""));
    return Number.isFinite(n) && v.trim() !== "" ? n : null;
  }
  return null;
}

export type SurpriseRow = {
  fiscalQtrEnd: string;
  dateReported: string;
  eps: number;
  consensusForecast: string;
  percentageSurprise: string;
};

export type LastReport = {
  lastDate: string | null;
  lastFiscalQ: string | null;
  lastEps: number | null;
  lastConsensus: number | null;
  surprisePct: number | null;
};

/** parse /api/company/{SYMBOL}/earnings-surprise → newest report first */
export function parseLastReport(json: unknown): LastReport {
  const j = json as { data?: { earningsSurpriseTable?: { rows?: SurpriseRow[] } } };
  const rows = j?.data?.earningsSurpriseTable?.rows ?? [];
  if (rows.length === 0) return { lastDate: null, lastFiscalQ: null, lastEps: null, lastConsensus: null, surprisePct: null };
  const r = rows[0];
  return {
    lastDate: parseUsDate(r.dateReported),
    lastFiscalQ: r.fiscalQtrEnd || null,
    lastEps: parseMoney(r.eps),
    lastConsensus: parseMoney(r.consensusForecast),
    surprisePct: parseMoney(r.percentageSurprise),
  };
}

export type CalendarRow = {
  lastYearRptDt: string;
  time: string;
  symbol: string;
  name: string;
  fiscalQuarterEnding: string;
  epsForecast: string;
};

export type NextReport = {
  nextDate: string;
  nextTime: NextTime;
  nextFiscalQ: string | null;
  nextEpsEst: number | null;
  lastYearRptDt: string | null;
};

/** parse one day of /api/calendar/earnings (the report date is the
 *  requested calendar day — the rows don't repeat it) */
export function parseNextCalendar(json: unknown, day: string): NextReport[] {
  const j = json as { data?: { rows?: CalendarRow[] } };
  const rows = j?.data?.rows ?? [];
  const out: NextReport[] = [];
  for (const r of rows) {
    if (!r.symbol) continue;
    out.push({
      nextDate: day,
      nextTime: r.time === "time-pre-market" ? "bmo" : r.time === "time-after-hours" ? "amc" : null,
      nextFiscalQ: r.fiscalQuarterEnding || null,
      nextEpsEst: parseMoney(r.epsForecast),
      lastYearRptDt: r.lastYearRptDt || null,
    });
  }
  return out;
}

function addDaysIso(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function addYears(day: string, years: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** display-only estimate for the next report date: last year's same-
 *  quarter report +1y when the calendar told us it, otherwise the last
 *  actual report +91d (the standard quarterly cadence). */
export function estimateNextDate(lastYearRptDt: string | null, lastDate: string | null): string | null {
  if (lastYearRptDt) {
    const d = parseUsDate(lastYearRptDt);
    if (d) return addYears(d, 1);
  }
  return lastDate ? addDaysIso(lastDate, 91) : null;
}

/** merge last + next into the panel row, with the estimate fallback.
 *  time-not-supplied = the calendar date is an ESTIMATE (not yet
 *  confirmed by the company), so it is flagged accordingly. */
export function buildRow(symbol: string, name: string, last: LastReport, next: NextReport | null): EarningsRow {
  if (next) {
    return {
      symbol,
      name,
      ...last,
      nextDate: next.nextDate,
      nextEstimated: next.nextTime === null,
      nextTime: next.nextTime,
      nextFiscalQ: next.nextFiscalQ,
      nextEpsEst: next.nextEpsEst,
    };
  }
  return {
    symbol,
    name,
    ...last,
    nextDate: estimateNextDate(null, last.lastDate),
    nextEstimated: true,
    nextTime: null,
    nextFiscalQ: null,
    nextEpsEst: null,
  };
}

export function sortRows(rows: EarningsRow[]): EarningsRow[] {
  const key = (r: EarningsRow) => (r.nextDate ? `0${r.nextDate}` : `1${r.symbol}`);
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

/* ---------------- fetch (server-side) ----------------------------- */

const NASDAQ = "https://api.nasdaq.com/api";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 60;
const DELAY_MS = 250;

async function getJson(url: string): Promise<unknown> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(500); // HTTP/2 internal errors are common on this host
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** rows with at least one real field — the "is this provider actually
 *  answering" signal (nulls across the board = upstream dead) */
function usableCount(rows: EarningsRow[]): number {
  return rows.filter((r) => r.lastDate || r.lastFiscalQ || r.nextDate).length;
}

async function fetchEarningsNasdaq(): Promise<EarningsData> {
  /* 1 — confirmed next dates: scan the forward calendar day-by-day */
  const want = new Set(NQ_MAJOR.map((t) => t.symbol));
  const nextBySymbol = new Map<string, NextReport>();
  const start = new Date(Date.now() + DAY_MS);
  for (let i = 0; i < MAX_SCAN_DAYS && want.size > 0; i++) {
    const d = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    let json: unknown;
    try {
      json = await getJson(`${NASDAQ}/calendar/earnings?date=${d}`);
    } catch {
      continue; // one bad day shouldn't kill the scan
    }
    for (const r of (json as { data?: { rows?: CalendarRow[] } }).data?.rows ?? []) {
      const sym = r.symbol.toUpperCase();
      if (want.has(sym) && !nextBySymbol.has(sym)) {
        const next = parseNextCalendar({ data: { rows: [r] } } as unknown, d)[0];
        if (next) {
          nextBySymbol.set(sym, next);
          want.delete(sym);
        }
      }
    }
    await sleep(DELAY_MS);
  }

  /* 2 — last reports per symbol */
  const rows: EarningsRow[] = [];
  for (const { symbol, name } of NQ_MAJOR) {
    let last: LastReport = { lastDate: null, lastFiscalQ: null, lastEps: null, lastConsensus: null, surprisePct: null };
    try {
      last = parseLastReport(await getJson(`${NASDAQ}/company/${symbol}/earnings-surprise`));
    } catch {
      /* leave nulls */
    }
    rows.push(buildRow(symbol, name, last, nextBySymbol.get(symbol) ?? null));
    await sleep(DELAY_MS);
  }

  return { asOf: new Date().toISOString(), provider: "nasdaq", rows: sortRows(rows) };
}

/* ---------------- Finnhub fallback (free key) --------------------- *
 * Verified Oct 2026 with a real free key: /calendar/earnings (future
 * dates incl. hour bmo/amc/"" = unconfirmed) and /stock/earnings
 * (last quarters: period/actual/estimate/surprisePercent). No report
 * DATE in /stock/earnings — the panel shows the period label instead.
 * ------------------------------------------------------------------ */

const FINNHUB = "https://finnhub.io/api/v1";

type FhCalendarRow = { symbol?: string; date?: string; hour?: string; epsEstimate?: number | null };

export async function fetchEarningsFinnhub(): Promise<EarningsData> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("no FINNHUB_API_KEY");
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 45 * DAY_MS).toISOString().slice(0, 10);
  const cal = (await getJson(`${FINNHUB}/calendar/earnings?from=${from}&to=${to}&token=${key}`)) as {
    earningsCalendar?: FhCalendarRow[];
  };
  const bySym = new Map<string, FhCalendarRow>();
  for (const r of cal.earningsCalendar ?? []) {
    if (r.symbol && !bySym.has(r.symbol.toUpperCase())) bySym.set(r.symbol.toUpperCase(), r);
  }

  const rows: EarningsRow[] = [];
  for (const { symbol, name } of NQ_MAJOR) {
    let last: LastReport = { lastDate: null, lastFiscalQ: null, lastEps: null, lastConsensus: null, surprisePct: null };
    try {
      const ear = (await getJson(`${FINNHUB}/stock/earnings?symbol=${symbol}&token=${key}`)) as {
        period?: string;
        actual?: number | null;
        estimate?: number | null;
        surprisePercent?: number | null;
      }[];
      const r = ear?.[0];
      if (r) {
        last = {
          lastDate: null, // Finnhub reports the quarter END, not the report date
          lastFiscalQ: r.period ?? null,
          lastEps: r.actual ?? null,
          lastConsensus: r.estimate ?? null,
          surprisePct: r.surprisePercent ?? null,
        };
      }
    } catch {
      /* leave nulls */
    }
    const c = bySym.get(symbol);
    const next: NextReport | null = c?.date
      ? {
          nextDate: c.date,
          nextTime: c.hour === "bmo" ? "bmo" : c.hour === "amc" ? "amc" : null,
          nextFiscalQ: null,
          nextEpsEst: c.epsEstimate ?? null,
          lastYearRptDt: null,
        }
      : null;
    rows.push(buildRow(symbol, name, last, next));
    await sleep(DELAY_MS);
  }

  return { asOf: new Date().toISOString(), provider: "finnhub", rows: sortRows(rows) };
}

export async function fetchEarnings(): Promise<{ data: EarningsData; fetchedAt: string }> {
  try {
    const data = await fetchEarningsNasdaq();
    if (usableCount(data.rows) < NQ_MAJOR.length / 2) {
      throw new Error(`nasdaq answered but unusable: ${usableCount(data.rows)}/${NQ_MAJOR.length} rows`);
    }
    return { data, fetchedAt: new Date().toISOString() };
  } catch (nasdaqErr) {
    try {
      const data = await fetchEarningsFinnhub();
      if (usableCount(data.rows) < 1) {
        throw new Error(`finnhub answered but unusable: ${usableCount(data.rows)} rows`);
      }
      return { data, fetchedAt: new Date().toISOString() };
    } catch (finnhubErr) {
      throw new Error(
        `earnings chain failed — nasdaq: ${nasdaqErr instanceof Error ? nasdaqErr.message : String(nasdaqErr)} | finnhub: ${
          finnhubErr instanceof Error ? finnhubErr.message : String(finnhubErr)
        }`,
      );
    }
  }
}

/* ---------------- full-NDX quarter view ---------------------------- *
 * The dedicated "all upcoming earnings for the quarter" panel: every
 * Nasdaq-100 constituent with its next earnings date for the coming
 * ~90 days, enriched with last-report detail for the top-30 names.
 *   - constituents: api.nasdaq.com/api/quote/list-type/nasdaq100
 *     (101 rows, one keyless call, 24 h cache)
 *   - next dates: Finnhub /calendar/earnings (3-day chunked — the feed
 *     caps at 1500 rows newest-first and would otherwise drop the
 *     nearest weeks) when FINNHUB_API_KEY is set; otherwise a
 *     day-by-day Nasdaq calendar scan (≤90 calls, 6 h cache)
 *   - last reports: the existing top-30 path (fetchEarnings)
 * ------------------------------------------------------------------ */

export type QuarterRow = {
  symbol: string;
  name: string;
  nextDate: string | null;
  nextEstimated: boolean;
  nextTime: NextTime;
  nextEpsEst: number | null;
};

export type ReportedRow = {
  symbol: string;
  name: string;
  /** "YYYY-MM-DD" report date (null when the fallback only has the period) */
  reportedDate: string | null;
  fiscalQ: string | null;
  eps: number | null;
  consensus: number | null;
  surprisePct: number | null;
};

export type QuarterData = {
  asOf: string;
  provider: "nasdaq" | "finnhub";
  /** every name that has reported — most recent first */
  reported: ReportedRow[];
  /** every name with a known next date — soonest first */
  upcoming: QuarterRow[];
};

const cacheQ = new Map<string, { at: number; value: unknown }>();
const inflightQ = new Map<string, Promise<unknown>>();

async function cachedQ<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cacheQ.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const pending = inflightQ.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn().then(
    (value) => {
      cacheQ.set(key, { at: Date.now(), value });
      inflightQ.delete(key);
      return value;
    },
    (err) => {
      inflightQ.delete(key);
      throw err;
    },
  );
  inflightQ.set(key, p);
  return p;
}

/** map over `items` with at most `limit` in flight — polite to the
 *  undocumented Nasdaq endpoints while keeping the 101-name refresh
 *  quick (~15 s at limit 3) */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function fetchNdxConstituents(): Promise<{ symbol: string; name: string }[]> {
  const j = (await getJson(`${NASDAQ}/quote/list-type/nasdaq100`)) as {
    data?: { data?: { rows?: { symbol?: string; companyName?: string }[] } };
  };
  const rows = j?.data?.data?.rows ?? [];
  if (rows.length < 50) throw new Error(`nasdaq100 list short: ${rows.length}`);
  return rows
    .filter((r) => r.symbol && r.companyName)
    .map((r) => ({ symbol: r.symbol!.toUpperCase(), name: r.companyName! }));
}

export type FhCalendarHit = { date: string; hour: string; epsEstimate: number | null };

/* Finnhub caps /calendar/earnings at 1500 rows, returned newest-first,
 * so one wide request silently truncates away the nearest weeks (every
 * October report disappeared from a 90-day window). Fetch in 3-day
 * chunks — well under the cap even at earnings-season peak (~340
 * rows/day) — and re-fetch any chunk that hits the cap day by day. */
const FH_MAX_ROWS = 1500;
const FH_CHUNK_DAYS = 3;

/** Finnhub full-market earnings calendar → per-symbol EARLIEST date map.
 *  A name can report twice inside a 90-day window, so keep the soonest
 *  date per symbol, not the first row seen. */
export async function fetchFinnhubCalendar(from: string, to: string): Promise<Map<string, FhCalendarHit>> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("no FINNHUB_API_KEY");
  const map = new Map<string, FhCalendarHit>();
  const ingest = (rows: FhCalendarRow[]) => {
    for (const r of rows) {
      if (!r.symbol || !r.date) continue;
      const sym = r.symbol.toUpperCase();
      const cur = map.get(sym);
      if (!cur || r.date < cur.date) {
        map.set(sym, { date: r.date, hour: r.hour ?? "", epsEstimate: r.epsEstimate ?? null });
      }
    }
  };
  for (let day = from; day <= to; ) {
    const end = addDaysIso(day, FH_CHUNK_DAYS - 1) > to ? to : addDaysIso(day, FH_CHUNK_DAYS - 1);
    const j = (await getJson(`${FINNHUB}/calendar/earnings?from=${day}&to=${end}&token=${key}`)) as {
      earningsCalendar?: FhCalendarRow[];
    };
    const rows = j.earningsCalendar ?? [];
    if (rows.length >= FH_MAX_ROWS) {
      /* capped: the earliest days of this chunk were dropped — fetch
       * the chunk one day at a time so nothing is lost */
      for (let d = day; d <= end; d = addDaysIso(d, 1)) {
        const jd = (await getJson(`${FINNHUB}/calendar/earnings?from=${d}&to=${d}&token=${key}`)) as {
          earningsCalendar?: FhCalendarRow[];
        };
        ingest(jd.earningsCalendar ?? []);
        await sleep(DELAY_MS);
      }
    } else {
      ingest(rows);
    }
    await sleep(DELAY_MS);
    day = addDaysIso(end, 1);
  }
  if (map.size === 0) throw new Error("finnhub calendar empty");
  return map;
}

/** last report per symbol — Nasdaq surprise table (report date) with a
 *  Finnhub fallback (period end only, reportedDate null) */
async function lastReportFor(symbol: string): Promise<ReportedRow | null> {
  try {
    const l = parseLastReport(await getJson(`${NASDAQ}/company/${symbol}/earnings-surprise`));
    if (!l.lastDate && !l.lastEps && !l.lastFiscalQ) return null;
    return { symbol, name: "", reportedDate: l.lastDate, fiscalQ: l.lastFiscalQ, eps: l.lastEps, consensus: l.lastConsensus, surprisePct: l.surprisePct };
  } catch {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return null;
    try {
      const ear = (await getJson(`${FINNHUB}/stock/earnings?symbol=${symbol}&token=${key}`)) as {
        period?: string;
        actual?: number | null;
        estimate?: number | null;
        surprisePercent?: number | null;
      }[];
      const r = ear?.[0];
      if (!r) return null;
      return { symbol, name: "", reportedDate: null, fiscalQ: r.period ?? null, eps: r.actual ?? null, consensus: r.estimate ?? null, surprisePct: r.surprisePercent ?? null };
    } catch {
      return null;
    }
  }
}

/** Nasdaq forward-calendar scan for the given symbols (tomorrow → up to
 *  `days` out, early-exit once every symbol has a date). Used as the
 *  whole-panel fallback when Finnhub fails and as a top-up for the few
 *  names Finnhub's calendar doesn't carry. */
async function scanNasdaqCalendar(symbols: Iterable<string>, days: number): Promise<Map<string, FhCalendarHit>> {
  const want = new Set([...symbols].map((s) => s.toUpperCase()));
  const map = new Map<string, FhCalendarHit>();
  for (let i = 1; i <= days && want.size > 0; i++) {
    const d = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    try {
      const json = await getJson(`${NASDAQ}/calendar/earnings?date=${d}`);
      for (const r of (json as { data?: { rows?: CalendarRow[] } }).data?.rows ?? []) {
        const sym = r.symbol.toUpperCase();
        if (want.has(sym)) {
          map.set(sym, {
            date: d,
            hour: r.time,
            epsEstimate: parseMoney(r.epsForecast),
          });
          want.delete(sym);
        }
      }
    } catch {
      /* one bad day shouldn't kill the scan */
    }
    await sleep(DELAY_MS);
  }
  return map;
}

export async function fetchNdxQuarter(): Promise<QuarterData> {
  const constituents = await cachedQ("ndx-constituents", 24 * 3600_000, fetchNdxConstituents);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  /* next dates: Finnhub first, then a Nasdaq forward scan */
  let provider: QuarterData["provider"] = "finnhub";
  let nextBySymbol: Map<string, FhCalendarHit>;
  try {
    nextBySymbol = await fetchFinnhubCalendar(from, to);
    /* Finnhub's calendar doesn't carry every NDX name (ASML, GOOG,
     * SPCX, TRI…). Top up the missing ones from Nasdaq so the Upcoming
     * ledger really is every name with a known next date. */
    const missing = constituents.map((t) => t.symbol).filter((s) => !nextBySymbol.has(s));
    if (missing.length > 0) {
      try {
        const topup = await scanNasdaqCalendar(missing, 90);
        for (const [s, hit] of topup) if (!nextBySymbol.has(s)) nextBySymbol.set(s, hit);
      } catch {
        /* keep the Finnhub rows; a partial ledger beats none */
      }
    }
  } catch {
    provider = "nasdaq";
    nextBySymbol = await scanNasdaqCalendar(
      constituents.map((t) => t.symbol),
      90,
    );
  }

  /* last report for EVERY constituent (3 in flight, 150 ms between chunks) */
  const reports = await mapLimit(constituents, 3, async ({ symbol }) => {
    await sleep(150);
    return lastReportFor(symbol);
  });

  const reported: ReportedRow[] = [];
  for (let i = 0; i < constituents.length; i++) {
    const r = reports[i];
    if (r) reported.push({ ...r, name: constituents[i].name });
  }
  reported.sort((a, b) => {
    const ka = a.reportedDate ?? a.fiscalQ ?? "0000";
    const kb = b.reportedDate ?? b.fiscalQ ?? "0000";
    return kb.localeCompare(ka); // most recent first
  });

  const upcoming: QuarterRow[] = constituents
    .flatMap(({ symbol, name }): QuarterRow[] => {
      const hit = nextBySymbol.get(symbol);
      if (!hit) return [];
      const hour = hit.hour ?? "";
      const nextTime: NextTime = hour === "time-pre-market" || hour === "bmo" ? "bmo" : hour === "time-after-hours" || hour === "amc" ? "amc" : null;
      return [
        {
          symbol,
          name,
          nextDate: hit.date,
          nextEstimated: hour !== "time-pre-market" && hour !== "time-after-hours" && hour !== "bmo" && hour !== "amc",
          nextTime,
          nextEpsEst: hit.epsEstimate ?? null,
        },
      ];
    })
    .sort((a, b) => a.nextDate!.localeCompare(b.nextDate!)); // soonest first

  return { asOf: new Date().toISOString(), provider, reported, upcoming };
}
