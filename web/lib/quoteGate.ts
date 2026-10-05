/* ------------------------------------------------------------------ *
 * Broker quote-agreement gate — the 2026-10-04 instant-stop guard.
 *
 * On the Sunday reopen the GoCharting tape lagged the real MNQZ6
 * market by ~15 pts (tape 31141 vs broker 31155): the market order
 * filled ABOVE the signal's take-profit and the OCO closed the entry
 * the same second. Order type cannot fully prevent that class of
 * failure — only price agreement can.
 *
 * Before any live entry the gate reads the CME MNQ price (Yahoo's
 * MNQ=F continuous front month — CrossTrade serves no market data for
 * Tradovate-linked accounts) and refuses when |quote − signal entry|
 * exceeds QUOTE_AGREE_MAX_PTS (default 3 pts — normal tape noise is
 * well under that; the reopen divergence was 14.75). Prints are
 * accepted up to 10 minutes old: a stale-ish CME print still catches
 * the persistent tape/broker divergence this gate exists for.
 *
 * When no fresh quote is available the gate follows QUOTE_AGREE_NODATA:
 *   "allow"  (default) — fail OPEN with a warning: the protection is
 *            skipped (visible in the order's exec_log reason)
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
 *  price; maxAgeMs bounds how stale a quote may be for gate purposes —
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

/** the single broker-side price source: Yahoo's CME MNQ continuous.
 *  Returns null when the fetch fails or the print is stale. */
export async function fetchBrokerQuote(): Promise<number | null> {
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

/** the entry gate for live placements: refuse when the CME MNQ price and
 *  the signal entry disagree beyond the threshold. Policy on unreadable
 *  quote per QUOTE_AGREE_NODATA (allow by default — logged, never silent). */
export async function quoteAgreeGate(entry: number): Promise<{ ok: boolean; reason: string }> {
  if (process.env.QUOTE_AGREE_CHECK === "0") return { ok: true, reason: "quote check disabled (QUOTE_AGREE_CHECK=0)" };
  const maxPts = Number(process.env.QUOTE_AGREE_MAX_PTS ?? "3");
  const quote = await fetchBrokerQuote();
  const decision = quoteAgreeDecision(quote, entry, maxPts);
  if (decision === "diverge") {
    return {
      ok: false,
      reason: `quote check: MNQ ${quote!.toFixed(2)} is ${Math.abs(quote! - entry).toFixed(1)} pts from signal entry ${entry.toFixed(2)} (max ${maxPts}) — refusing`,
    };
  }
  if (decision === "nodata") {
    if (process.env.QUOTE_AGREE_NODATA === "refuse") {
      return { ok: false, reason: "quote check: no fresh MNQ quote — refusing (QUOTE_AGREE_NODATA=refuse)" };
    }
    console.warn("[crossTrade] quote check: no fresh MNQ quote — allowing (QUOTE_AGREE_NODATA=allow)");
    return { ok: true, reason: "no fresh MNQ quote — divergence check skipped" };
  }
  return { ok: true, reason: `MNQ ${quote!.toFixed(2)} within ${maxPts} pts of entry` };
}
