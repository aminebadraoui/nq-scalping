/* ------------------------------------------------------------------ *
 * Server-side CBOE options refresher — the intraday 0DTE feed.
 *
 * Mirrors lib/live.ts: a long-lived singleton that polls the free CBOE
 * delayed-quotes endpoint on an interval so the gamma walls (and 0DTE
 * open interest as it builds through the day) stay current, instead of
 * being a once-a-day snapshot.
 *
 * Honest bounds (docs/strategy/OPTIONS_SIGNAL.md §8):
 *   - CBOE is delayed ~15 min and the endpoint is UNDOCUMENTED. Polling
 *     faster than the delay buys nothing for price and only raises the
 *     ban risk, so the default is 5 minutes. Override with
 *     OPTIONS_REFRESH_SECONDS (min 30s). Back off / raise the interval if
 *     it starts returning 429s — the walls are not worth losing the feed.
 *   - 0DTE OI builds during the day; the "near" bucket (≤7d) captures it
 *     once the feed refreshes intraday. True same-day 0DTE OI is only
 *     knowable intraday — exactly what this loop provides.
 * ------------------------------------------------------------------ */

import { promises as fs } from "fs";
import path from "path";
import {
  parseChain,
  inferSpot,
  computeGamma,
  computeGammaByExpiry,
  type GammaRead,
  type OptionRow,
  type OptionsRefreshMeta,
} from "./options";

const SYMBOL = process.env.OPTIONS_SYMBOL || "QQQ";
const DATA_DIR = process.env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
const OPTIONS_DIR = path.join(DATA_DIR, "options");

const KEEP = ["option", "bid", "ask", "iv", "open_interest", "volume", "delta", "gamma"] as const;

function refreshSeconds(): number {
  const n = Number(process.env.OPTIONS_REFRESH_SECONDS);
  return Number.isFinite(n) && n >= 30 ? n : 300;
}

async function fetchCboe(symbol: string): Promise<{ options: OptionRow[]; timestamp: string; asOf: string }> {
  const url = `https://cdn-api.cboe.com/api/global/delayed_quotes/options/${symbol}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`CBOE HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { options?: OptionRow[] }; timestamp?: string };
  const options = j?.data?.options ?? [];
  const timestamp = j?.timestamp ?? "";
  const asOf = timestamp.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return { options, timestamp, asOf };
}

function compactOptions(options: OptionRow[]): Record<string, unknown>[] {
  return options.map((o) => Object.fromEntries(KEEP.map((k) => [k, o[k]])));
}

class OptionsFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  gamma: GammaRead | null = null;
  private meta: OptionsRefreshMeta = {
    symbol: SYMBOL,
    asOf: "",
    lastFetch: 0,
    nextFetch: 0,
    intervalMs: refreshSeconds() * 1000,
    lastError: null,
    fetched: false,
  };

  async refresh(): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    this.meta.nextFetch = Date.now() + this.meta.intervalMs;
    try {
      const { options, timestamp, asOf } = await fetchCboe(SYMBOL);
      if (options.length === 0) throw new Error("empty chain");
      const rows = parseChain(options);
      const spot = inferSpot(rows);
      const g = computeGamma(rows, spot);
      g.buckets = computeGammaByExpiry(rows, spot, asOf);
      this.gamma = g;
      this.meta.asOf = asOf;
      this.meta.lastFetch = Date.now();
      this.meta.lastError = null;
      this.meta.fetched = true;
      // best-effort persist so a restart (and the file fallback) see the freshest chain
      try {
        await fs.mkdir(OPTIONS_DIR, { recursive: true });
        await fs.writeFile(
          path.join(OPTIONS_DIR, `${SYMBOL}_${asOf}.json`),
          JSON.stringify({ symbol: SYMBOL, timestamp, options: compactOptions(options) }),
        );
      } catch {
        /* read-only volume — memory stays the source of truth */
      }
    } catch (e) {
      this.meta.lastError = String(e);
    } finally {
      this.fetching = false;
    }
  }

  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.meta.intervalMs);
  }

  snapshot(): GammaRead | null {
    return this.gamma;
  }

  info(): OptionsRefreshMeta {
    return { ...this.meta };
  }
}

const g = globalThis as unknown as { __gcOptionsFeed?: OptionsFeed };

export function getOptionsFeed(): OptionsFeed {
  if (!g.__gcOptionsFeed) {
    g.__gcOptionsFeed = new OptionsFeed();
    g.__gcOptionsFeed.start();
  }
  return g.__gcOptionsFeed;
}
