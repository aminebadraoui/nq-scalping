/* ------------------------------------------------------------------ *
 * Order-level trade reconstruction — the correct pairing between
 * signal cards and CrossTrade fills.
 *
 * The greedy chronological approach mis-paired interleaved trades: a
 * trade's exit fill could be consumed as the next trade's entry (the
 * 12:58/12:59 mis-pairing). Instead, matching works on ORDERS:
 *
 *   · an ENTRY order is a top-level order (no parentId) whose own fills
 *     are on the signal side — webhook/REST brackets always create the
 *     entry as the OSO parent;
 *   · its EXITS are the fills of its CHILD orders (parentId = entry id):
 *     the stop/target legs. Fallback (manual covers, missing children)
 *     scans chronologically after the entry, bounded by the next entry.
 *
 * Pure functions, unit-tested — the CLI (scripts/reconcileTrades.ts)
 * feeds them the session orders + fills.
 * ------------------------------------------------------------------ */

export type OrderRow = {
  id: string;
  ts: number; // epoch ms (order timestamp)
  action: "Buy" | "Sell";
  parentId: string | null;
};

export type FillRow = {
  ts: number;
  action: "Buy" | "Sell";
  qty: number;
  price: number;
  orderId: string;
  instrument: string;
  commission: number;
  fees: number;
  account?: string; // accountName from the fill record (reconcile fills it)
};

export type EntryGroup = { order: OrderRow; fills: FillRow[] };

/** top-level orders with their own same-side fills, sorted by order time —
 *  the pool of possible entries. */
export function entryCandidates(orders: OrderRow[], fills: FillRow[]): EntryGroup[] {
  const byOrder = new Map<string, FillRow[]>();
  for (const f of fills) {
    const a = byOrder.get(f.orderId) ?? [];
    a.push(f);
    byOrder.set(f.orderId, a);
  }
  const out: EntryGroup[] = [];
  for (const o of orders) {
    if (o.parentId !== null) continue; // children are exits, never entries
    const fs = (byOrder.get(o.id) ?? []).filter((f) => f.action === o.action);
    if (!fs.length) continue;
    out.push({ order: o, fills: fs.sort((a, b) => a.ts - b.ts) });
  }
  out.sort((a, b) => a.order.ts - b.order.ts);
  return out;
}

/** match a signal to its entry order(s): same side, within the time
 *  window, combined qty reaches the signal's contracts (>= 80%). Handles
 *  scale-out (bank + runner = two entry orders for one card). */
export function selectEntries(
  sig: { ts: number; side: "long" | "short"; contracts: number },
  candidates: EntryGroup[],
  usedIds: Set<string>,
  windowBeforeMs = 30_000,
  windowAfterMs = 15 * 60_000,
): EntryGroup[] {
  const want: FillRow["action"] = sig.side === "long" ? "Buy" : "Sell";
  const picked: EntryGroup[] = [];
  let qty = 0;
  for (const c of candidates) {
    if (usedIds.has(c.order.id)) continue;
    if (c.order.action !== want) continue;
    if (c.order.ts < sig.ts - windowBeforeMs || c.order.ts > sig.ts + windowAfterMs) continue;
    const cqty = c.fills.reduce((s, f) => s + f.qty, 0);
    if (cqty <= 0) continue;
    picked.push(c);
    qty += cqty;
    if (qty >= sig.contracts * 0.8) break;
  }
  return qty >= sig.contracts * 0.8 ? picked : [];
}

/**
 * Global entry assignment: every (signal, entry-candidate) pair is ranked
 * by |orderTs − signalTs| and entries are handed out nearest-first, one
 * order per signal up to two (scale-out bank + runner), requiring the
 * combined qty to reach 80% of the signal's contracts.
 *
 * This replaces sequential greedy matching: a phantom signal row (e.g.
 * from a stale local instance) can no longer steal a real card's entry
 * just because it was processed first — the CLOSEST signal wins.
 */
export function assignEntries(
  signals: Array<{ key: string; ts: number; side: "long" | "short"; contracts: number }>,
  candidates: EntryGroup[],
  windowBeforeMs = 30_000,
  windowAfterMs = 15 * 60_000,
): Map<string, EntryGroup[]> {
  const pairs: Array<{ dist: number; sigIdx: number; candIdx: number }> = [];
  signals.forEach((sig, i) => {
    const want: FillRow["action"] = sig.side === "long" ? "Buy" : "Sell";
    candidates.forEach((c, j) => {
      if (c.order.action !== want) return;
      const dist = c.order.ts - sig.ts; // negative = order before the card
      if (dist < -windowBeforeMs || dist > windowAfterMs) return;
      pairs.push({ dist: Math.abs(dist), sigIdx: i, candIdx: j });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);

  const usedOrder = new Set<number>();
  const qty = new Array(signals.length).fill(0);
  const out = new Map<string, EntryGroup[]>();
  for (const p of pairs) {
    if (usedOrder.has(p.candIdx)) continue;
    const sig = signals[p.sigIdx];
    if (qty[p.sigIdx] >= sig.contracts * 0.8) continue;
    const list = out.get(sig.key) ?? [];
    if (list.length >= 2) continue;
    const g = candidates[p.candIdx];
    list.push(g);
    out.set(sig.key, list);
    qty[p.sigIdx] += g.fills.reduce((s, f) => s + f.qty, 0);
    usedOrder.add(p.candIdx);
  }
  // drop signals that never reached 80% of their contracts
  for (const [k] of [...out]) {
    const i = signals.findIndex((s) => s.key === k);
    if (i < 0 || qty[i] < signals[i].contracts * 0.8) out.delete(k);
  }
  return out;
}

/** exit fills for the matched entries: their CHILD orders' fills. */
export function childExitFills(entries: EntryGroup[], orders: OrderRow[], fills: FillRow[]): FillRow[] {
  const entryIds = new Set(entries.map((e) => e.order.id));
  const byOrder = new Map<string, FillRow[]>();
  for (const f of fills) {
    const a = byOrder.get(f.orderId) ?? [];
    a.push(f);
    byOrder.set(f.orderId, a);
  }
  const childIds = orders.filter((o) => o.parentId !== null && entryIds.has(o.parentId)).map((o) => o.id);
  const out: FillRow[] = [];
  for (const cid of childIds) out.push(...(byOrder.get(cid) ?? []));
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** fallback exit: chronological opposite-side fills after the entry (for
 *  manual covers / missing children), bounded by the next entry order. */
export function fallbackExitFills(
  entries: EntryGroup[],
  fills: FillRow[],
  nextEntryTs: number | null,
  contracts: number,
  instrumentPrefix: string,
): FillRow[] {
  const lastEntryTs = Math.max(...entries.map((e) => e.order.ts));
  const want: FillRow["action"] = entries[0].fills[0].action === "Buy" ? "Sell" : "Buy";
  const out: FillRow[] = [];
  let qty = 0;
  for (const f of fills) {
    if (f.ts <= lastEntryTs) continue;
    if (nextEntryTs !== null && f.ts >= nextEntryTs) break;
    if (!f.instrument.startsWith(instrumentPrefix)) continue;
    if (f.action !== want) continue;
    out.push(f);
    qty += f.qty;
    if (qty >= contracts) break;
  }
  return out;
}
