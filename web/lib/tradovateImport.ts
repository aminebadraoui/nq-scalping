/* ------------------------------------------------------------------ *
 * Tradovate round-trip import — pure parsing + matching.
 *
 * Tradovate's fills export pairs every buy fill with its sell fill
 * ("round trips") and states the realized P&L per pair — the broker-side
 * ground truth. We use it two ways:
 *   1. CORRECT bot trades whose exits CrossTrade never captured (the
 *      journal's FLAT rows) or whose fallback pairing was wrong.
 *   2. RECORD the manual bucket (rows no signal explains) with real P&L.
 *
 * Money strings come as "$1,234.56" or "$(1,234.56)" (negative).
 * ------------------------------------------------------------------ */

export type RoundTrip = {
  key: string; // buyFillId|sellFillId
  symbol: string;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  pnlUsd: number;
  boughtAt: number; // epoch ms
  soldAt: number;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryAt: number;
  exitAt: number;
  day: string; // ET calendar date of the exit fill
};

const money = (s: string): number => {
  let t = s.trim();
  const neg = t.startsWith("$(") || t.startsWith("(");
  t = t.replace(/[$(),]/g, "");
  const v = Number(t);
  if (!Number.isFinite(v)) return 0;
  return neg ? -v : v;
};

const tsOf = (s: string): number => {
  // "10/01/2026 09:36:19" — US Eastern (the Tradovate UI export timezone)
  const [d, t] = s.trim().split(" ");
  const [mm, dd, yyyy] = d.split("/");
  const [hh, mi, ss] = t.split(":");
  return Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-04:00`);
};

export function parseTradovateCsv(text: string): RoundTrip[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  // header detection: first line contains the column names
  const headerIdx = lines.findIndex((l) => /buyFillId|symbol/.test(l) && /pnl/.test(l));
  const body = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines;
  const out: RoundTrip[] = [];
  for (const line of body) {
    const cols = line.split(",");
    if (cols.length < 11) continue;
    const symbol = cols[0];
    const buyFillId = cols[4];
    const sellFillId = cols[5];
    const qty = Number(cols[6]);
    const buyPrice = Number(cols[7]);
    const sellPrice = Number(cols[8]);
    const pnlUsd = money(cols[9]);
    const boughtAt = tsOf(cols[10]);
    const soldAt = tsOf(cols[11]);
    if (!Number.isFinite(qty) || !Number.isFinite(buyPrice) || !Number.isFinite(sellPrice)) continue;
    if (!Number.isFinite(boughtAt) || !Number.isFinite(soldAt)) continue;
    // Tradovate pairs fills buy-first in the export even for shorts;
    // the timestamps tell the true direction.
    const direction: RoundTrip["direction"] = boughtAt <= soldAt ? "long" : "short";
    const entryPrice = direction === "long" ? buyPrice : sellPrice;
    const exitPrice = direction === "long" ? sellPrice : buyPrice;
    const entryAt = direction === "long" ? boughtAt : soldAt;
    const exitAt = direction === "long" ? soldAt : boughtAt;
    const exitDay = new Date(exitAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    out.push({
      key: `${buyFillId}|${sellFillId}`,
      symbol,
      qty,
      buyPrice,
      sellPrice,
      pnlUsd,
      boughtAt,
      soldAt,
      direction,
      entryPrice,
      exitPrice,
      entryAt,
      exitAt,
      day: exitDay,
    });
  }
  return out;
}

/** A trade row as the importer needs it (subset of Neon `trades`). */
export type BotTrade = {
  signal_key: string;
  ts: number;
  side: string;
  contracts: number;
  gross_usd: number;
  fill_entry_at: string | null;
};

export type MatchResult = {
  matched: Array<{ trip: RoundTrip; signalKey: string; corrects: boolean }>;
  manual: RoundTrip[];
};

/** One-to-one nearest match of round trips to bot trades: same direction,
 *  qty within ±2, entry fill within ±3 min of the trip's entry. Unmatched
 *  trips are the manual bucket. `corrects` = the trip changes the trade's
 *  P&L by more than $1 (only then should the DB row be updated). */
export function matchRoundTrips(trips: RoundTrip[], trades: BotTrade[]): MatchResult {
  const usedTrips = new Set<number>();
  const usedSignals = new Set<string>();
  const matched: MatchResult["matched"] = [];
  const manual: RoundTrip[] = [];

  const pushMatch = (trip: RoundTrip, idxs: number[], t: BotTrade): void => {
    for (const ix of idxs) usedTrips.add(ix);
    usedSignals.add(t.signal_key);
    matched.push({
      trip,
      signalKey: t.signal_key,
      corrects: Math.abs(trip.pnlUsd - t.gross_usd) > 1,
    });
  };

  // pass 1: single-row trips (one row per trade)
  for (const t of trades) {
    let best: number | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < trips.length; i++) {
      if (usedTrips.has(i)) continue;
      const trip = trips[i];
      if (trip.direction !== t.side) continue;
      // exact qty only in pass 1 — a partial leg (6 of 8 contracts) must
      // wait for the grouping pass, or it steals the trade with half the P&L
      if (trip.qty !== t.contracts) continue;
      const fillAt = t.fill_entry_at ? Date.parse(t.fill_entry_at) : NaN;
      const anchor = Number.isFinite(fillAt) ? fillAt : t.ts;
      const delta = Math.abs(trip.entryAt - anchor);
      if (delta <= 3 * 60_000 && delta < bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    if (best === null) continue;
    pushMatch(trips[best], [best], t);
  }

  // pass 2: multi-leg trips (partial fills like 6+8=14) — cluster unused
  // trips by symbol+direction whose entries sit within 2 min, then match
  // clusters whose SUM qty fits a remaining trade
  const unusedIdx = trips.map((_, i) => i).filter((i) => !usedTrips.has(i));
  const groups: Array<number[]> = [];
  for (const i of unusedIdx) {
    let placed = false;
    for (const g of groups) {
      if (
        Math.abs(trips[g[0]].entryAt - trips[i].entryAt) <= 2 * 60_000 &&
        trips[g[0]].direction === trips[i].direction &&
        trips[g[0]].symbol === trips[i].symbol
      ) {
        g.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([i]);
  }
  for (const t of trades) {
    if (usedSignals.has(t.signal_key)) continue;
    const fillAt = t.fill_entry_at ? Date.parse(t.fill_entry_at) : NaN;
    const anchor = Number.isFinite(fillAt) ? fillAt : t.ts;
    for (const g of groups) {
      if (g.some((ix) => usedTrips.has(ix))) continue;
      const legs = g.map((ix) => trips[ix]);
      // time proximity is NON-negotiable: a cluster hours away is a manual
      // trade, not this signal (regression: the 09:36 manual +$900 was once
      // matched to an evening bot signal because qty alone fit)
      if (Math.abs(legs[0].entryAt - anchor) > 3 * 60_000) continue;
      const qty = legs.reduce((s, x) => s + x.qty, 0);
      if (Math.abs(qty - t.contracts) > 2) continue;
      const pnl = legs.reduce((s, x) => s + x.pnlUsd, 0);
      const entryPrice = legs.reduce((s, x) => s + x.qty * x.entryPrice, 0) / qty;
      const exitPrice = legs.reduce((s, x) => s + x.qty * x.exitPrice, 0) / qty;
      const combined: RoundTrip = {
        ...legs[0],
        key: legs.map((x) => x.key).join("+"),
        qty,
        pnlUsd: Math.round(pnl * 100) / 100,
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
      };
      pushMatch(combined, g, t);
      break;
    }
  }

  for (let i = 0; i < trips.length; i++) {
    if (!usedTrips.has(i)) manual.push(trips[i]);
  }
  return { matched, manual };
}
