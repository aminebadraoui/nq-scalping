/* ------------------------------------------------------------------ *
 * Price-action box — premium / discount across six timeframes.
 *
 * The one question this box answers: is price in the DISCOUNT (cheap)
 * or the PREMIUM (expensive) half of each timeframe's dealing range —
 * and are they all pointing the same way?
 *
 *   DISCOUNT  = below the 50% equilibrium of the range  → buy here
 *   PREMIUM   = above the 50% equilibrium               → sell here
 *   OTE       = the "optimal trade entry" retracement bands
 *               (61.8–78.6% retracement, i.e. 21.4–38.2% from the low
 *               for longs, 61.8–78.6% for shorts) — the sweet spot.
 *
 * Each timeframe's dealing range is the high/low of its CURRENT calendar
 * candle (still forming), bucketed on the feed's own US-Central wall clock:
 * 4h → the 4-hour block, 1h → the clock hour, 15m/5m/1m → the quarter/
 * five-minute/minute bar. Bucketing by calendar candle — rather than a
 * trailing window of bars — both makes each gauge reflect a real candle and
 * clips it to the current session, so a short live session never reaches
 * back into a previous trading day. The Daily range is the trading session
 * high/low (RTH-defined, consistent with the profile stack) rather than a
 * calendar candle, so it is the actual "daily candle" for an intraday scalp.
 *
 * This is a LOCATION filter, not a trigger: it tells you whether you
 * would be buying cheap or chasing. It composes with the order-flow
 * box (the trigger) into one final signal — see lib/signals.ts.
 *
 * Caveat (same as the rest of the system): every threshold here is a
 * hypothesis until it survives 100+ journalled trades. The "discount /
 * premium" idea is a repackaging of two older, better-documented ideas
 * — auction-market value area (Dalton) and range mean-reversion — plus
 * the ICT dealing-range language. It is NOT an independently validated
 * edge on its own. See docs/strategy/PRICE_ACTION_SIGNAL.md.
 * ------------------------------------------------------------------ */

export type TF = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type TFConfig = {
  tf: TF;
  label: string;
  /** fallback trailing 1-minute bars when a bar carries no clock time; 0 = session range */
  window: number;
  /** calendar candle size in seconds (0 = session range, used for the daily) */
  bucket: number;
  /** alignment weight — higher timeframes are the context, so they weigh more */
  weight: number;
};

export const TIMEFRAMES: TFConfig[] = [
  { tf: "1d", label: "Daily", window: 0, bucket: 0, weight: 3 },
  { tf: "4h", label: "4H", window: 240, bucket: 14400, weight: 3 },
  { tf: "1h", label: "1H", window: 60, bucket: 3600, weight: 2 },
  { tf: "15m", label: "15m", window: 15, bucket: 900, weight: 2 },
  { tf: "5m", label: "5m", window: 5, bucket: 300, weight: 1 },
  { tf: "1m", label: "1m", window: 1, bucket: 60, weight: 1 },
];

export const MAX_SCORE = TIMEFRAMES.reduce((s, t) => s + t.weight, 0); // 12

/** the ±band around equilibrium (50%) that reads as "mid-range" instead of a side */
export const EQ_BAND = 0.05;
/** OTE retracement bands, as fractions of the range measured from the low */
export const OTE_LONG: [number, number] = [0.214, 0.382];
export const OTE_SHORT: [number, number] = [0.618, 0.786];
/** weighted score needed to declare a side, with ≤ OPP_FLOOR on the wrong side */
export const SIDE_FLOOR = 8;
export const OPP_FLOOR = 2;

export type Zone = "discount" | "equilibrium" | "premium";

export type Minute = {
  high: number;
  low: number;
  /** feed-clock "HH:mm" (optional); when present, calendar-candle bucketing is used */
  t?: string;
  /** feed-clock calendar date (optional) — keeps buckets from crossing trading days */
  d?: string;
};

export type TFRead = {
  tf: TF;
  label: string;
  weight: number;
  low: number;
  high: number;
  eq: number;
  /** position of lastPrice within [low, high], 0..1 */
  pct: number;
  zone: Zone;
  ote: "long" | "short" | null;
  /** false when the window had no usable range (not enough bars, flat range) */
  enough: boolean;
};

export type PriceActionRead = {
  side: "long" | "short" | null;
  tone: "long" | "short" | "neutral";
  verdict: string;
  headline: string;
  rows: TFRead[];
  longScore: number;
  shortScore: number;
  maxScore: number;
  discountCount: number;
  premiumCount: number;
  /** strict alignment: every timeframe on one side, none on the opposite */
  aligned: "long" | "short" | null;
  narrative: string;
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function zoneOf(pct: number): Zone {
  if (pct < 0.5 - EQ_BAND) return "discount";
  if (pct > 0.5 + EQ_BAND) return "premium";
  return "equilibrium";
}

export function oteOf(pct: number): "long" | "short" | null {
  if (pct >= OTE_LONG[0] && pct <= OTE_LONG[1]) return "long";
  if (pct >= OTE_SHORT[0] && pct <= OTE_SHORT[1]) return "short";
  return null;
}

/** feed wall-clock "HH:mm" + calendar date → a calendar-candle key.
 *  e.g. 4h → "…T04:00" blocks, 1h → "…T04:00", 15m → "…T04:30", 5m → "…T04:40", 1m → "…T04:42". */
function candleKey(t: string, d: string | undefined, bucketSec: number): string {
  const [h, m] = t.split(":").map(Number);
  const stepMin = Math.max(1, Math.round(bucketSec / 60));
  const bucketMin = Math.floor((h * 60 + m) / stepMin) * stepMin;
  return `${d ?? "?"}T${String(Math.floor(bucketMin / 60)).padStart(2, "0")}:${String(bucketMin % 60).padStart(2, "0")}`;
}

export function dealingRange(
  minutes: Minute[],
  tf: TF,
  sessionHigh?: number,
  sessionLow?: number,
): { low: number; high: number; enough: boolean } {
  const n = minutes.length;
  if (n === 0) return { low: NaN, high: NaN, enough: false };

  if (tf === "1d") {
    // the daily candle = the trading session high/low when known, else the
    // whole loaded day's range
    const have =
      Number.isFinite(sessionHigh) &&
      Number.isFinite(sessionLow) &&
      (sessionHigh as number) > (sessionLow as number) &&
      (sessionLow as number) > 0;
    const lo = have ? (sessionLow as number) : Math.min(...minutes.map((m) => m.low));
    const hi = have ? (sessionHigh as number) : Math.max(...minutes.map((m) => m.high));
    return { low: lo, high: hi, enough: Number.isFinite(lo) && Number.isFinite(hi) && hi > lo };
  }

  const cfg = TIMEFRAMES.find((t) => t.tf === tf)!;
  const last = minutes[n - 1];

  // Calendar-aligned path: the current (still-forming) candle of this
  // timeframe. Keying on date + wall-clock block both maps each gauge to a
  // real candle and stops a short live session from reaching into a prior
  // trading day (which had a different calendar date).
  if (cfg.bucket > 0 && last.t && /^\d{2}:\d{2}$/.test(last.t)) {
    const key = candleKey(last.t, last.d, cfg.bucket);
    const inCandle = minutes.filter(
      (m) => m.t && /^\d{2}:\d{2}$/.test(m.t) && candleKey(m.t, m.d, cfg.bucket) === key,
    );
    if (inCandle.length) {
      const lo = Math.min(...inCandle.map((m) => m.low));
      const hi = Math.max(...inCandle.map((m) => m.high));
      return { low: lo, high: hi, enough: Number.isFinite(lo) && Number.isFinite(hi) && hi > lo };
    }
  }

  // Fallback (bars without clock time): a trailing window of `window` bars.
  const w = Math.min(cfg.window, n);
  const slice = minutes.slice(n - w);
  const lo = Math.min(...slice.map((m) => m.low));
  const hi = Math.max(...slice.map((m) => m.high));
  return { low: lo, high: hi, enough: Number.isFinite(lo) && Number.isFinite(hi) && hi > lo };
}

export function readPriceAction(input: {
  minutes: Minute[];
  lastPrice: number;
  sessionHigh?: number;
  sessionLow?: number;
}): PriceActionRead {
  const { minutes, lastPrice } = input;
  const n = minutes.length;
  const lastHigh = n ? minutes[n - 1].high : 0;
  const price =
    Number.isFinite(lastPrice) && lastPrice > 0
      ? lastPrice
      : Number.isFinite(lastHigh) && lastHigh > 0
        ? lastHigh
        : 0;

  const rows: TFRead[] = TIMEFRAMES.map((cfg) => {
    const { low, high, enough } = dealingRange(minutes, cfg.tf, input.sessionHigh, input.sessionLow);
    const span = high - low;
    const pct = enough && span > 0 ? clamp01((price - low) / span) : 0.5;
    return {
      tf: cfg.tf,
      label: cfg.label,
      weight: cfg.weight,
      low,
      high,
      eq: enough && span > 0 ? low + span / 2 : NaN,
      pct,
      zone: enough ? zoneOf(pct) : "equilibrium",
      ote: enough ? oteOf(pct) : null,
      enough,
    };
  });

  let longScore = 0;
  let shortScore = 0;
  let discountCount = 0;
  let premiumCount = 0;
  for (const r of rows) {
    if (r.zone === "discount") {
      longScore += r.weight;
      discountCount++;
    } else if (r.zone === "premium") {
      shortScore += r.weight;
      premiumCount++;
    }
  }

  const side: "long" | "short" | null =
    longScore >= SIDE_FLOOR && shortScore <= OPP_FLOOR
      ? "long"
      : shortScore >= SIDE_FLOOR && longScore <= OPP_FLOOR
        ? "short"
        : null;

  const aligned: "long" | "short" | null =
    shortScore === 0 && longScore > 0 ? "long" : longScore === 0 && shortScore > 0 ? "short" : null;

  let tone: PriceActionRead["tone"] = "neutral";
  let verdict: string;
  let headline: string;
  if (side === "long") {
    tone = "long";
    verdict = `LONG LOCATION — price is in discount on ${discountCount}/6 timeframes (weighted ${longScore}/${MAX_SCORE})`;
    headline =
      aligned === "long" ? "buying cheap on every timeframe" : "buying cheap on the context timeframes";
  } else if (side === "short") {
    tone = "short";
    verdict = `SHORT LOCATION — price is in premium on ${premiumCount}/6 timeframes (weighted ${shortScore}/${MAX_SCORE})`;
    headline =
      aligned === "short" ? "selling expensive on every timeframe" : "selling expensive on the context timeframes";
  } else {
    tone = "neutral";
    verdict = `MIXED LOCATION — ${discountCount} discount · ${premiumCount} premium · ${
      6 - discountCount - premiumCount
    } mid — wait for alignment`;
    headline = "price is cheap on some timeframes and expensive on others";
  }

  const parts: string[] = [];
  const disc = rows.filter((r) => r.zone === "discount").map((r) => r.label);
  const prem = rows.filter((r) => r.zone === "premium").map((r) => r.label);
  const mid = rows.filter((r) => r.zone === "equilibrium").map((r) => r.label);
  if (disc.length) parts.push(`discount on ${disc.join(", ")}`);
  if (prem.length) parts.push(`premium on ${prem.join(", ")}`);
  if (mid.length) parts.push(`mid-range on ${mid.join(", ")}`);
  const oteRows = rows.filter((r) => r.ote);
  if (oteRows.length)
    parts.push(`OTE ${oteRows.map((r) => (r.ote === "long" ? "buy" : "sell")).join("/")} zone reached on ${oteRows.map((r) => r.label).join(", ")}`);
  const narrative =
    n === 0
      ? "no bars in the visible window — nothing to locate against"
      : parts.length
        ? parts.join("; ") + "."
        : "no dealing range loaded.";

  return {
    side,
    tone,
    verdict,
    headline,
    rows,
    longScore,
    shortScore,
    maxScore: MAX_SCORE,
    discountCount,
    premiumCount,
    aligned,
    narrative,
  };
}
