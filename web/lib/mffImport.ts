/* ------------------------------------------------------------------ *
 * MFF (MyFundedFutures) trades import — the DEFINITIVE record.
 *
 * The MFF UI lists each round-trip trade with NET P&L (commissions
 * included) — the same numbers that sum to the account's total P&L.
 * This is the journal's foundation import: it supersedes the Tradovate
 * gross-only round trips and the CrossTrade pairing for everything it
 * covers, because it is what the account actually paid.
 *
 * Format (one block per trade, symbol repeated at the end of each block):
 *   <qty>
 *   <entry datetime "Oct 02, 2:25:11 PM">
 *   $<entry price>
 *   LONG|SHORT
 *   <duration>
 *   <exit datetime>
 *   $<exit price>
 *   ±$<net pnl>
 *   MNQZ6|MESZ6
 * ------------------------------------------------------------------ */

export type MffTrade = {
  key: string;
  symbol: string;
  qty: number;
  direction: "long" | "short";
  entryAt: number; // epoch ms (ET)
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  netUsd: number;
  grossUsd: number;
  feesUsd: number;
  day: string;
};

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "Oct 02, 2:25:11 PM" → epoch ms (America/New_York) */
export function mffTs(s: string): number {
  const m = s.trim().match(/^(\w{3}) (\d{2}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (!m) return NaN;
  let h = Number(m[3]);
  if (m[6] === "PM" && h !== 12) h += 12;
  if (m[6] === "AM" && h === 12) h = 0;
  const d = new Date(Date.UTC(2026, MONTHS[m[1]], Number(m[2]), h, Number(m[4]), Number(m[5])));
  // build as UTC then shift by the ET offset (EDT = -4) so Date.parse
  // semantics stay deterministic year-round for this import
  return d.getTime() + 4 * 3600_000;
}

export const mffMoney = (s: string): number => {
  const t = s.trim().replace(/[$(),]/g, "");
  const v = Number(t);
  return Number.isFinite(v) ? v : 0;
};

export function parseMffTrades(text: string): MffTrade[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: MffTrade[] = [];
  let i = 0;
  while (i < lines.length) {
    // a trade block starts with a bare integer qty followed by 8 fields
    if (!/^\d+$/.test(lines[i])) {
      i++;
      continue;
    }
    const qty = Number(lines[i]);
    const entryLine = lines[i + 1];
    const entryPrice = lines[i + 2];
    const direction = lines[i + 3];
    const exitLine = lines[i + 5];
    const exitPrice = lines[i + 6];
    const pnlLine = lines[i + 7];
    const symbol = lines[i + 8] ?? "";
    if (
      !entryLine || !exitLine || !entryPrice || !exitPrice || !pnlLine ||
      (direction !== "LONG" && direction !== "SHORT") ||
      !/^[-+]?\$/.test(pnlLine)
    ) {
      i++;
      continue;
    }
    const entryAt = mffTs(entryLine);
    const exitAt = mffTs(exitLine);
    if (!Number.isFinite(entryAt) || !Number.isFinite(exitAt)) {
      i++;
      continue;
    }
    const entry = mffMoney(entryPrice);
    const exit = mffMoney(exitPrice);
    const net = mffMoney(pnlLine.replace("+", ""));
    const dir = direction === "LONG" ? "long" : "short";
    const pv = symbol === "MESZ6" ? 5 : 2;
    const grossMag = Math.abs(exit - entry) * qty * pv;
    // SIGNED gross (the journal convention: losses negative), and fees =
    // signedGross − net — correct for wins AND losses (e.g. −175 − (−201.60)
    // = +26.60 fees, not the naive gross − net = +376.60)
    const signedGross = net >= 0 ? grossMag : -grossMag;
    out.push({
      key: `${symbol}|${entryAt}|${qty}|${net}`,
      symbol,
      qty,
      direction: dir,
      entryAt,
      exitAt,
      entryPrice: entry,
      exitPrice: exit,
      netUsd: net,
      grossUsd: Math.round(signedGross * 100) / 100,
      feesUsd: Math.round((signedGross - net) * 100) / 100,
      day: new Date(exitAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    });
    i += 9; // qty + 8 fields; blank lines (if any) are skipped by the scanner
  }
  return out;
}

/** A bot trade row as the importer needs it. */
export type BotTrade = {
  signal_key: string;
  ts: number;
  side: string;
  contracts: number;
  gross_usd: number;
  fill_entry_at: string | null;
};

export type MffAssignment = {
  signalKey: string;
  mff: MffTrade;
  botQty: number;
  netUsd: number;
  grossUsd: number;
  feesUsd: number;
  exitAvg: number;
  result: "win" | "loss" | "flat";
};

export type MffMatchResult = {
  assignments: MffAssignment[]; // bot portion of each matched MFF trade
  manual: Array<MffTrade & { splitQty: number; splitNet: number; splitFees: number }>; // unmatched + leftover splits
  matchedKeys: Set<string>;
};

/** Match MFF round trips to bot trades by entry time (±3 min) + direction.
 *  When the MFF trade is BIGGER than the bot signal (the broker grouped a
 *  manual add-on with the bot's entry), the P&L is split proportionally —
 *  the bot keeps its contracts' share, the rest is the manual bucket. */
export function matchMff(mff: MffTrade[], botTrades: BotTrade[]): MffMatchResult {
  const used = new Set<number>();
  const usedSignals = new Set<string>();
  const assignments: MffAssignment[] = [];
  const manual: MffMatchResult["manual"] = [];

  for (const t of botTrades) {
    if (usedSignals.has(t.signal_key)) continue;
    if (t.side !== "long" && t.side !== "short") continue;
    const fillAt = t.fill_entry_at ? Date.parse(t.fill_entry_at) : NaN;
    const anchor = Number.isFinite(fillAt) ? fillAt : t.ts;
    let best: number | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mff.length; i++) {
      if (used.has(i)) continue;
      if (mff[i].direction !== t.side) continue;
      const delta = Math.abs(mff[i].entryAt - anchor);
      if (delta <= 3 * 60_000 && delta < bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    if (best === null) continue;
    used.add(best);
    usedSignals.add(t.signal_key);
    const m = mff[best];
    const share = m.qty > 0 ? Math.min(1, t.contracts / m.qty) : 1;
    const net = Math.round(m.netUsd * share * 100) / 100;
    const gross = Math.round(m.grossUsd * share * 100) / 100;
    const fees = Math.round(m.feesUsd * share * 100) / 100;
    assignments.push({
      signalKey: t.signal_key,
      mff: m,
      botQty: t.contracts,
      netUsd: net,
      grossUsd: gross,
      feesUsd: fees,
      exitAvg: m.exitPrice,
      result: net > 0.5 ? "win" : net < -0.5 ? "loss" : "flat",
    });
    // leftover beyond the bot's contracts is a manual add-on
    const leftover = m.qty - t.contracts;
    if (leftover > 2) {
      const lShare = leftover / m.qty;
      manual.push({
        ...m,
        splitQty: leftover,
        splitNet: Math.round(m.netUsd * lShare * 100) / 100,
        splitFees: Math.round(m.feesUsd * lShare * 100) / 100,
      });
    }
  }

  for (let i = 0; i < mff.length; i++) {
    if (!used.has(i)) {
      const m = mff[i];
      manual.push({ ...m, splitQty: m.qty, splitNet: m.netUsd, splitFees: m.feesUsd });
    }
  }
  return { assignments, manual, matchedKeys: usedSignals };
}
