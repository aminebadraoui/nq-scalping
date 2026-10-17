/* ------------------------------------------------------------------ *
 * Footprint imbalance engine — shared by the server data layer and the
 * live (tick-built) footprint in the browser, so both agree exactly.
 *
 * Definition used (standard footprint reading):
 *   DIAGONAL  buy at price P  vs  sell at P - 1 tick   (>= 3:1) -> buy imbalance
 *             sell at price P vs  buy  at P + 1 tick   (>= 3:1) -> sell imbalance
 *   HORIZONTAL buy vs sell in the SAME row (>= 3:1), both sides > 0
 * A row where one side never traded is NOT an imbalance: it is an
 * unfinished auction (only one side showed up at that price).
 * STACKED = 3+ consecutive rows imbalanced the same way: one side being
 * filled systematically at a price — the absorption fingerprint in tape.
 *
 * Explicit decisions (these change flag counts, so they are named, not
 * accidental):
 *   · ZERO COUNTERPART in a diagonal — a row whose own side >= IMB_MIN is
 *     flagged even when the neighbouring tick's opposite side never traded
 *     (ratio treated as infinite, which is how footprint tools mark a
 *     one-sided print). Set IMB_ALLOW_ZERO_COUNTERPART = false for the
 *     strict reading: only count it when the counterpart actually traded.
 *     167 of 26,113 rows in the 2026-09-25 RTH session are such rows.
 *   · STACK TIES — the LAST maximal run wins (see `run >= stacked.len`).
 *   · A row carrying BOTH a buy and a sell diagonal is classified "buy" in
 *     the stack classifier (deterministic precedence) while the summary
 *     counts it on both sides.
 * ------------------------------------------------------------------ */

export type ImbSide = "buy" | "sell" | null;

export type FPLevel = {
  price: number;
  buy: number;
  sell: number;
  bTrades: number;
  sTrades: number;
  /** diagonal imbalance: this row's buy vs the row one tick BELOW its sell (>=3:1) */
  dBuy: boolean;
  /** diagonal imbalance: this row's sell vs the row one tick ABOVE its buy (>=3:1) */
  dSell: boolean;
  /** horizontal imbalance: this row's own buy vs its own sell (>=3:1) */
  hBuy: boolean;
  hSell: boolean;
  ratio: number; // horizontal: dominant side / weak side (1 = balanced)
  dBuyRatio: number; // diagonal buy ratio: row buy / (row below sell)
  dSellRatio: number; // diagonal sell ratio: row sell / (row above buy)
};

export type ImbStack = { side: "buy" | "sell"; from: number; to: number; len: number };

export type ImbSummary = {
  buy: number; // rows with a buy-side imbalance (diag or horizontal)
  sell: number;
  dBuy: number;
  dSell: number;
  stacked: ImbStack | null; // longest run of >=3 consecutive same-side imbalance rows
  biased: "buy" | "sell" | null; // dominant side when buy/sell counts differ clearly
};

export const IMB_RATIO = 3;
export const IMB_MIN = 10;
/** see the note in the header — flip to false for the strict reading */
export const IMB_ALLOW_ZERO_COUNTERPART = true;

export function imbalanceFor(rows: { price: number; buy: number; sell: number; bTrades?: number; sTrades?: number }[]): FPLevel[] {
  // rows are sorted high -> low; index +1 is one tick (0.25) BELOW
  return rows.map((r, i) => {
    const below = rows[i + 1];
    const above = rows[i - 1];
    const ratio = Math.max(r.buy, r.sell) / Math.max(1, Math.min(r.buy, r.sell));
    const dBuyRatio = below ? r.buy / Math.max(1, below.sell) : 0;
    const dSellRatio = above ? r.sell / Math.max(1, above.buy) : 0;
    const dBuyOk = !!below && (IMB_ALLOW_ZERO_COUNTERPART || below.sell > 0);
    const dSellOk = !!above && (IMB_ALLOW_ZERO_COUNTERPART || above.buy > 0);
    const dBuy = dBuyOk && r.buy >= IMB_MIN && dBuyRatio >= IMB_RATIO;
    const dSell = dSellOk && r.sell >= IMB_MIN && dSellRatio >= IMB_RATIO;
    const tot = r.buy + r.sell;
    // a zero-side tick is an UNFINISHED AUCTION (drawn as a box), not a
    // horizontal imbalance: both sides must have traded for 3:1 to mean anything
    const hBuy = tot >= IMB_MIN && r.sell > 0 && r.buy >= IMB_RATIO * r.sell;
    const hSell = tot >= IMB_MIN && r.buy > 0 && r.sell >= IMB_RATIO * r.buy;
    return { ...r, bTrades: r.bTrades ?? 0, sTrades: r.sTrades ?? 0, dBuy, dSell, hBuy, hSell, ratio, dBuyRatio, dSellRatio };
  });
}

/** trigger-bar aligned trade-count fraction: bT/(bT+sT) for longs, mirror
 *  for shorts, over the bar's levels. null when the bar carries no counts
 *  (the fail-open value the min_count_frac gate must see). */
export function alignedCountFrac(levels: { bTrades: number; sTrades: number }[], dir: "long" | "short"): number | null {
  let bT = 0;
  let sT = 0;
  for (const l of levels) {
    bT += l.bTrades;
    sT += l.sTrades;
  }
  const tc = bT + sT;
  if (tc === 0) return null;
  return dir === "long" ? bT / tc : sT / tc;
}

export function summarizeImb(levels: FPLevel[]): ImbSummary {
  let buy = 0;
  let sell = 0;
  let dBuy = 0;
  let dSell = 0;
  for (const l of levels) {
    if (l.dBuy || l.hBuy) buy++;
    if (l.dSell || l.hSell) sell++;
    if (l.dBuy) dBuy++;
    if (l.dSell) dSell++;
  }
  // longest run of >= 3 consecutive rows imbalanced the same way (stacked imbalance)
  let stacked: ImbStack | null = null;
  let run = 0;
  let side: "buy" | "sell" = "buy";
  let start = 0;
  const end = (i: number) => levels[Math.min(levels.length - 1, i)].price;
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    const s: "buy" | "sell" | null = l.dBuy || l.hBuy ? "buy" : l.dSell || l.hSell ? "sell" : null;
    if (!s) {
      run = 0;
      continue;
    }
    if (run > 0 && s === side) run++;
    else {
      side = s;
      run = 1;
      start = i;
    }
    if (run >= 3 && (!stacked || run >= stacked.len)) {
      stacked = { side, from: levels[start].price, to: end(start + run - 1), len: run };
    }
  }
  const biased: "buy" | "sell" | null = buy >= sell * 1.5 && buy - sell >= 2 ? "buy" : sell >= buy * 1.5 && sell - buy >= 2 ? "sell" : null;
  return { buy, sell, dBuy, dSell, stacked, biased };
}

