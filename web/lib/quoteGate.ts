/* ------------------------------------------------------------------ *
 * Broker quote-agreement gate — the 2026-10-04 instant-stop guard.
 *
 * On the Sunday reopen the GoCharting tape lagged the real MNQZ6
 * market by ~15 pts (tape 31141 vs broker 31155): the market order
 * filled ABOVE the signal's take-profit and the OCO closed the entry
 * the same second. Order type cannot fully prevent that class of
 * failure — only price agreement can.
 *
 * Before any live entry the gate reads a broker-side MNQ price — the
 * CrossTrade quote routes when they serve (market data is NT8-add-on
 * only per CrossTrade's docs; Tradovate-linked accounts never get
 * quotes from them) and Yahoo's CME MNQ continuous otherwise — and
 * refuses when |quote − signal entry| exceeds QUOTE_AGREE_MAX_PTS
 * (default 3 pts — normal tape noise is well under that; the reopen
 * divergence was 14.75). Yahoo prints are accepted up to 10 minutes
 * old: a stale-ish CME print still catches the persistent tape/broker
 * divergence this gate exists for.
 *
 * When no source yields a fresh quote the gate follows
 * QUOTE_AGREE_NODATA:
 *   "allow"  (default) — fail OPEN with a warning: a down quote client
 *            never halts live execution, but the protection is skipped
 *            (the skip is visible in the order's exec_log reason)
 *   "refuse" — fail CLOSED (consistent with the flat/guard gates)
 * QUOTE_AGREE_CHECK=0 disables the gate entirely.
 * ------------------------------------------------------------------ */

export function quoteAgreeDecision(
  quote: number | null,
  entry: number,
  maxPts: number,
): "ok" | "diverge" | "nodata" {
  if (quote === null || !Number.isFinite(quote)) return "nodata";
  return Math.abs(quote - entry) > maxPts ? "diverge" : "ok";
}

/** parse Yahoo's chart response for the MNQ continuous front month
 *  (pure + unit-tested). Returns null when the payload has no fresh
 *  price; MAX_AGE_MS bounds how stale a quote may be for gate purposes —
 *  a 10-minute-old CME print still catches the persistent tape/broker
 *  divergence this gate exists for, but nothing older is trusted. */
export function parseYahooChartQuote(raw: unknown, nowMs: number, maxAgeMs = 600_000): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = (raw as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } }).chart?.result?.[0];
  const m = r?.meta;
  if (!m || typeof m !== "object") return null;
  const price = Number(m.regularMarketPrice);
  const t = Number(m.regularMarketTime);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(t) || nowMs - t * 1000 > maxAgeMs) return null;
  return price;
}

/** read a broker-side MNQ price for the agreement gate, best source
 *  first:
 *   1. CrossTrade's quote routes — NT8-only per their docs (market data
 *      is never served for Tradovate-linked accounts, so these fail
 *      closed with "Client not ready" here; kept for NT8 setups)
 *   2. Yahoo's CME MNQ continuous (MNQ=F) — free, ~real-time-ish, the
 *      practical source for a Tradovate account.
 *  Returns null when every source fails or no fresh price is present. */
export async function fetchBrokerQuote(
  instrument: string,
  account: string,
  key: string,
): Promise<number | null> {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const priceFrom = (d: Record<string, unknown> | null | undefined): number | null => {
    if (!d || typeof d !== "object") return null;
    const bid = num(d.bid ?? d.bidPrice);
    const ask = num(d.ask ?? d.askPrice);
    if (bid !== null && ask !== null) return (bid + ask) / 2;
    const last = num(d.last ?? d.lastPrice ?? d.price ?? d.close ?? d.mark ?? d.mid);
    if (last !== null) return last;
    const q = (d.quote ?? (Array.isArray(d.quotes) ? d.quotes[0] : null)) as Record<string, unknown> | null;
    return q ? priceFrom(q) : null;
  };

  const urls = [
    `https://app.crosstrade.io/v1/api/market/quote?instrument=${encodeURIComponent(instrument)}`,
    `https://app.crosstrade.io/v1/api/accounts/${encodeURIComponent(account)}/quote?instrument=${encodeURIComponent(instrument)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { success?: boolean; data?: Record<string, unknown> } | Record<string, unknown>;
      if (typeof j === "object" && j !== null) {
        const price = priceFrom((j as { data?: Record<string, unknown> }).data ?? j);
        if (price !== null && price > 0) return price;
      }
    } catch {
      /* try the next route */
    }
  }
  // CrossTrade serves no market data for Tradovate accounts (NT8-only per
  // their docs) — fall back to Yahoo's CME MNQ continuous front month.
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/MNQ%3DF?interval=1m&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0 (nq-scalping quote gate)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const price = parseYahooChartQuote(await res.json(), Date.now());
      if (price !== null && price > 0) return price;
    }
  } catch {
    /* no fresh quote — nodata policy decides */
  }
  return null;
}

/** the entry gate for live placements: refuse when the broker quote and
 *  the signal entry disagree beyond the threshold. Policy on unreadable
 *  quote per QUOTE_AGREE_NODATA (allow by default — logged, never silent). */
export async function quoteAgreeGate(
  cfg: { account: string; key: string },
  entry: number,
  instrument: string,
): Promise<{ ok: boolean; reason: string }> {
  if (process.env.QUOTE_AGREE_CHECK === "0") return { ok: true, reason: "quote check disabled (QUOTE_AGREE_CHECK=0)" };
  const maxPts = Number(process.env.QUOTE_AGREE_MAX_PTS ?? "3");
  const quote = await fetchBrokerQuote(instrument, cfg.account, cfg.key);
  const decision = quoteAgreeDecision(quote, entry, maxPts);
  if (decision === "diverge") {
    return {
      ok: false,
      reason: `quote check: broker ${quote!.toFixed(2)} is ${Math.abs(quote! - entry).toFixed(1)} pts from signal entry ${entry.toFixed(2)} (max ${maxPts}) — refusing`,
    };
  }
  if (decision === "nodata") {
    if (process.env.QUOTE_AGREE_NODATA === "refuse") {
      return { ok: false, reason: "quote check: broker quote unreadable — refusing (QUOTE_AGREE_NODATA=refuse)" };
    }
    console.warn("[crossTrade] quote check: broker quote unreadable — allowing (QUOTE_AGREE_NODATA=allow)");
    return { ok: true, reason: "quote unreadable — divergence check skipped" };
  }
  return { ok: true, reason: `quote ${quote!.toFixed(2)} within ${maxPts} pts of entry` };
}
