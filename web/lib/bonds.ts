/* ------------------------------------------------------------------ *
 * US Treasury curve — pure parsing + derived spreads for the bonds
 * dashboard panel. Display-only macro context: nothing here feeds the
 * signal engine.
 *
 * Sources (all free, no key, official):
 *   1. Daily Treasury Par Yield Curve CSV — home.treasury.gov
 *      …/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve
 *      Header: Date,"1 Mo","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr",
 *      "3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr" — newest row first,
 *      published ~15:30 ET each business day (never revised).
 *   2. Daily Treasury Real Yield Curve CSV — same base URL with
 *      type=daily_treasury_real_yield_curve → 5/7/10/20/30 Yr real
 *      yields. Breakeven 10y = nominal − real.
 *   3. NY Fed EFFR (markets.newyorkfed.org/api/rates/unsecured/effr/
 *      search.json) — effective fed funds + FOMC target range, ~9:00 ET
 *      next business day. Optional card; fails gracefully.
 *
 * Pure functions, unit-tested (tests/bonds.test.mjs).
 * ------------------------------------------------------------------ */

export type CurvePoint = {
  /** "YYYY-MM-DD" (converted from the feed's M/D/YYYY) */
  date: string;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y2: number | null;
  y5: number | null;
  y10: number | null;
  y20: number | null;
  y30: number | null;
};

export type BondsData = {
  /** date of the newest curve row */
  asOf: string;
  curve: CurvePoint[];
  /** newest nominal row (same as curve[0] when fresh) */
  latest: CurvePoint | null;
  /** real yields: 5/7/10/20/30y */
  real: { date: string; y10: number | null }[];
  /** fed funds effective + FOMC target range */
  effr: { date: string; rate: number | null; targetFrom: number | null; targetTo: number | null } | null;
};

/** one-day change in basis points (old → new); null when either side missing */
export function bpDiff(next: number | null, prev: number | null): number | null {
  if (next == null || prev == null || !Number.isFinite(next) || !Number.isFinite(prev)) return null;
  return Math.round((next - prev) * 100);
}

/** 2s10s spread in bps (10y − 2y) */
export function spread210(p: CurvePoint): number | null {
  return p.y10 != null && p.y2 != null ? Math.round((p.y10 - p.y2) * 100) : null;
}

/** 10y − 3m spread in bps */
export function spread103m(p: CurvePoint): number | null {
  return p.y10 != null && p.m3 != null ? Math.round((p.y10 - p.m3) * 100) : null;
}

/** real 10y yield for the nominal row's date */
export function real10y(
  nominal: { date: string; y10: number | null },
  real: { date: string; y10: number | null }[],
): number | null {
  const r = real.find((x) => x.date === nominal.date);
  return r?.y10 ?? null;
}

/** 10y breakeven inflation in % (nominal 10y − real 10y, same date) */
export function breakeven10y(
  nominal: { date: string; y10: number | null },
  real: { date: string; y10: number | null }[],
): number | null {
  const r = real10y(nominal, real);
  if (r == null || nominal.y10 == null) return null;
  return Math.round((nominal.y10 - r) * 100) / 100;
}

/* --- feed-specific CSV handling ------------------------------------- *
 * The Treasury CSV has no embedded commas/quotes inside fields beyond
 * the quoted header labels, so a plain comma split is safe — but the
 * header is mapped by NAME, so column reordering in future feed updates
 * won't break the parse.
 * -------------------------------------------------------------------- */

const HEADER_KEYS: Record<string, keyof CurvePoint> = {
  "1 mo": "m1",
  "3 mo": "m3",
  "6 mo": "m6",
  "1 yr": "y1",
  "2 yr": "y2",
  "5 yr": "y5",
  "10 yr": "y10",
  "20 yr": "y20",
  "30 yr": "y30",
};

function feedDateToIso(d: string): string {
  // "10/02/2026" → "2026-10-02"
  const parts = d.split("/");
  if (parts.length !== 3) return "";
  const [m, day, y] = parts;
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** parse the daily par yield curve CSV into newest-first rows */
export function parseTreasuryCsv(text: string): CurvePoint[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const col: Partial<Record<keyof CurvePoint, number>> = {};
  let dateCol = -1;
  header.forEach((h, i) => {
    if (h === "date") dateCol = i;
    const k = HEADER_KEYS[h];
    if (k) col[k] = i;
  });
  if (dateCol < 0) return [];

  const rows: CurvePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cells.length <= dateCol) continue;
    const date = feedDateToIso(cells[dateCol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const num = (key: keyof CurvePoint): number | null => {
      const idx = col[key];
      if (idx === undefined) return null;
      const n = Number(cells[idx]);
      return Number.isFinite(n) && cells[idx] !== "" ? n : null;
    };
    rows.push({
      date,
      m1: num("m1"),
      m3: num("m3"),
      m6: num("m6"),
      y1: num("y1"),
      y2: num("y2"),
      y5: num("y5"),
      y10: num("y10"),
      y20: num("y20"),
      y30: num("y30"),
    });
  }
  // feed is newest-first; ensure ordering regardless
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

const REAL_KEYS: Record<string, string> = {
  "5 yr": "y5",
  "7 yr": "y7",
  "10 yr": "y10",
  "20 yr": "y20",
  "30 yr": "y30",
};

/** parse the real yield curve CSV into newest-first rows */
export function parseRealYieldCsv(text: string): { date: string; y10: number | null }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  let dateCol = -1;
  let y10Col = -1;
  header.forEach((h, i) => {
    if (h === "date") dateCol = i;
    if (REAL_KEYS[h] === "y10") y10Col = i;
  });
  if (dateCol < 0 || y10Col < 0) return [];
  const rows: { date: string; y10: number | null }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (cells.length <= Math.max(dateCol, y10Col)) continue;
    const date = feedDateToIso(cells[dateCol]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const n = Number(cells[y10Col]);
    rows.push({ date, y10: Number.isFinite(n) && cells[y10Col] !== "" ? n : null });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

/** assemble the panel payload from the two CSVs (+ optional EFFR) */
export function buildBondsData(nominalCsv: string, realCsv: string, effr: BondsData["effr"]): BondsData {
  const curve = parseTreasuryCsv(nominalCsv);
  const real = parseRealYieldCsv(realCsv);
  const latest = curve[0] ?? null;
  return { asOf: latest?.date ?? "", curve, latest, real, effr };
}

/* ---------------- CNBC delayed intraday curve ---------------------- *
 * quote.cnbc.com restQuote — UNOFFICIAL, keyless, exchange-delayed
 * ~20 min. Display-only garnish between the Treasury's daily prints:
 * the panel shows the official daily curve plus this delayed row,
 * clearly labeled. Fragile by nature — failure is fine (null).
 * -------------------------------------------------------------------- */

export type IntradayCurve = {
  asOf: string; // ISO instant of the delayed quote
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y2: number | null;
  y5: number | null;
  y10: number | null;
  y30: number | null;
};

type CnbcQuote = {
  symbol?: string;
  last?: string; // "4.103%"
  last_time?: string; // "2026-10-02T17:05:00.000-0400"
};

type TenorKey = Exclude<keyof IntradayCurve, "asOf">;

const CNBC_TENORS: Record<string, TenorKey> = {
  US1M: "m1",
  US3M: "m3",
  US6M: "m6",
  US2Y: "y2",
  US5Y: "y5",
  US10Y: "y10",
  US30Y: "y30",
};

export function parseCnbcQuotes(json: unknown): IntradayCurve | null {
  const j = json as { FormattedQuoteResult?: { FormattedQuote?: CnbcQuote[] } };
  const quotes = j?.FormattedQuoteResult?.FormattedQuote ?? [];
  const out: IntradayCurve = { asOf: "", m1: null, m3: null, m6: null, y2: null, y5: null, y10: null, y30: null };
  let hit = 0;
  for (const q of quotes) {
    const key = CNBC_TENORS[q.symbol ?? ""];
    if (!key || q.last == null) continue;
    const n = Number(String(q.last).replace("%", ""));
    if (Number.isFinite(n)) {
      out[key] = n;
      hit++;
      if (q.last_time) out.asOf = q.last_time;
    }
  }
  return hit >= 2 ? out : null; // at least a partial curve
}
