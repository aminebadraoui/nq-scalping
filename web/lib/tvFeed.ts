/* ------------------------------------------------------------------ *
 * Tradovate live bar source (2026-10-25) — the PRIMARY live feed.
 *
 * Tails the md collector's JSONL journal (scripts/tradovateMd.ts →
 * data/tradovate-md/md-<ET-day>.jsonl) and builds NQ + ES minute bars
 * in the exact LiveMinute shape lib/live.ts serves to every consumer
 * (signal stack, executor, dashboards). lib/live.ts arbitrates: this
 * feed is used while healthy, GoCharting is the hot standby.
 *
 * Why a closed Tradovate bar is "confirmed" (source:"candle"):
 * Tradovate's tick chart is the FULL tape (day volume matches the GC
 * vendor day volume within 0.1%), unlike GC's ~7% trade-channel
 * sample, so once the minute has rolled and the tick-id sequence has
 * no holes, the bar is complete. `vendor:"tv"` keeps provenance.
 *
 * Completeness = tick ids are a per-contract sequence. A hole (a
 * reconnect that replayed fewer history elements than were missed, or
 * the collector's REST-poll fallback) marks the minute incomplete; the
 * arbiter treats an incomplete recent bar as unhealthy and fails over.
 * The first minute seen per symbol is always partial (we can't know
 * what came before the journal) and is never marked complete.
 * ------------------------------------------------------------------ */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { LiveMinute, Tick } from "./live";
import { sessionDayOf } from "./times";

const TICK = 0.25;
/** grace after the minute rolls before the bar is finalized — ticks of a
 *  packet can straddle the boundary and land a few hundred ms late */
export const TV_FINALIZE_MS = 1_500;
/** missing tick ids tolerated per minute (isolated 1-id holes are
 *  routine in the journal; anything larger is a real gap) */
export const TV_GAP_TOLERANCE = 2;
const MAX_MINUTES = 1380;
const MAX_TICKS = 2000;
const LEVEL_WINDOW = 30; // keep per-price levels on the last N bars only
const MAX_SEEN_IDS = 200_000;
const READ_CHUNK = 1024 * 1024; // ~70ms of parsing per chunk, then yield

export type TvRawTick = {
  t: number; // ms epoch (exchange time)
  price: number;
  size: number;
  bid: number | null;
  ask: number | null;
  id: number | null;
};

export type TvBar = LiveMinute & {
  /** start-of-minute ms epoch */
  ms: number;
  /** missing tick ids attributed to this minute */
  missing: number;
  /** first minute after a discontinuity — never complete */
  partial: boolean;
  trades: number;
  /** finalized (minute rolled + grace); complete bars also carry source:"candle" */
  closed: boolean;
};

export function tvSide(tk: { price: number; bid: number | null; ask: number | null }): 1 | -1 {
  if (tk.ask !== null && tk.price >= tk.ask) return 1;
  if (tk.bid !== null && tk.price <= tk.bid) return -1;
  if (tk.bid !== null && tk.ask !== null) return tk.price - tk.bid <= tk.ask - tk.price ? -1 : 1;
  return 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** decode one tick-chart packet (time = bt + t, price = (bp + p) × ts) */
export function decodeTvPacket(p: {
  bp: number;
  bt: number;
  ts?: number;
  tks: Array<{ t: number; p: number; s: number; b?: number; a?: number; id?: number }>;
}): TvRawTick[] {
  const ts = p.ts ?? TICK;
  return p.tks.map((k) => ({
    t: p.bt + k.t,
    price: round2((p.bp + k.p) * ts),
    size: k.s,
    bid: k.b !== undefined ? round2((p.bp + k.b) * ts) : null,
    ask: k.a !== undefined ? round2((p.bp + k.a) * ts) : null,
    id: k.id ?? null,
  }));
}

function minuteStart(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

/** Per-symbol minute builder. Pure state machine — unit-tested. */
export class TvBarBuilder {
  /** finalized + developing bars keyed by minute start ms */
  private bars = new Map<number, TvBar>();
  private order: number[] = [];
  private seen = new Set<number>();
  private lastId: number | null = null;
  ticks: Tick[] = [];
  /** wall-clock ms of the latest ingested tick's journal line */
  lastTickWallMs = 0;
  /** exchange time of the latest tick */
  lastTickMs = 0;
  lastPrice = 0;
  revision = 0;
  /** wall ms of the most recent finalize */
  lastFinalizeAt = 0;

  reset(): void {
    this.bars.clear();
    this.order = [];
    this.seen.clear();
    this.lastId = null;
    this.ticks = [];
    this.lastTickWallMs = 0;
    this.lastTickMs = 0;
    this.lastPrice = 0;
    this.revision++;
  }

  ingest(tk: TvRawTick, wallMs: number): void {
    if (!(tk.price > 0) || !(tk.size > 0)) return;
    let missing = 0;
    let fillsHole = false;
    if (tk.id !== null) {
      if (this.seen.has(tk.id)) return; // history replay after a resubscribe
      this.seen.add(tk.id);
      if (this.seen.size > MAX_SEEN_IDS) {
        const keep = [...this.seen].sort((a, b) => a - b).slice(-MAX_SEEN_IDS / 2);
        this.seen = new Set(keep);
      }
      if (this.lastId === null) this.lastId = tk.id;
      else if (tk.id > this.lastId) {
        missing = tk.id - this.lastId - 1;
        this.lastId = tk.id;
      } else fillsHole = true; // unseen older id: a late fill of an earlier hole
    }
    const m0 = minuteStart(tk.t);
    let bar = this.bars.get(m0);
    if (!bar) {
      const iso = new Date(m0).toISOString();
      bar = {
        t: iso.slice(11, 16),
        du: iso.slice(0, 10),
        ms: m0,
        o: tk.price,
        h: tk.price,
        l: tk.price,
        c: tk.price,
        vol: 0,
        buy: 0,
        sell: 0,
        live: true,
        source: "tick",
        vendor: "tv",
        levels: {},
        levelTrades: {},
        missing: 0,
        // the first minute this builder ever sees can't be proven whole
        partial: this.bars.size === 0,
        trades: 0,
        closed: false,
      };
      this.bars.set(m0, bar);
      this.order.push(m0);
      if (this.order.length > 1 && this.order[this.order.length - 2] > m0) this.order.sort((a, b) => a - b);
      if (this.order.length > MAX_MINUTES) {
        for (const k of this.order.splice(0, this.order.length - MAX_MINUTES)) this.bars.delete(k);
      }
      for (let i = 0; i < this.order.length - LEVEL_WINDOW; i++) {
        const b = this.bars.get(this.order[i]);
        if (b) {
          delete b.levels;
          delete b.levelTrades;
        }
      }
    }
    if (fillsHole) bar.missing = Math.max(0, bar.missing - 1);
    else bar.missing += missing;
    const side = tvSide(tk);
    bar.h = Math.max(bar.h, tk.price);
    bar.l = Math.min(bar.l, tk.price);
    if (tk.t >= this.lastTickMs) {
      bar.c = tk.price;
      this.lastPrice = tk.price;
      this.lastTickMs = tk.t;
    }
    bar.vol += tk.size;
    if (side === 1) bar.buy += tk.size;
    else bar.sell += tk.size;
    bar.trades++;
    if (bar.levels) {
      const k = (Math.round(tk.price / TICK) * TICK).toFixed(2);
      const cell = bar.levels[k] ?? [0, 0];
      cell[side === 1 ? 0 : 1] += tk.size;
      bar.levels[k] = cell;
      const lt = (bar.levelTrades ??= {});
      const tc = lt[k] ?? [0, 0];
      tc[side === 1 ? 0 : 1] += 1;
      lt[k] = tc;
    }
    // a tick landing in an already-finalized bar is a revision
    if (bar.closed) this.revision++;
    this.lastTickWallMs = Math.max(this.lastTickWallMs, wallMs);
    this.ticks.push({ ms: tk.t, ltp: tk.price, size: tk.size, side });
    if (this.ticks.length > MAX_TICKS) this.ticks = this.ticks.slice(-MAX_TICKS);
  }

  /** Finalize every bar whose minute has rolled (+grace). A bar is only
   *  stamped source:"candle" when it is complete (no id holes, not the
   *  partial first minute). Returns the number finalized. */
  finalize(nowMs: number): number {
    let n = 0;
    for (const k of this.order) {
      const b = this.bars.get(k)!;
      if (b.source === "candle" || b.closed) continue;
      if (nowMs < k + 60_000 + TV_FINALIZE_MS) break;
      b.closed = true;
      if (tvBarComplete(b)) b.source = "candle";
      n++;
    }
    if (n) {
      this.revision++;
      this.lastFinalizeAt = nowMs;
    }
    return n;
  }

  /** closed bars (finalized, complete or not), oldest first */
  closedBars(): TvBar[] {
    const out: TvBar[] = [];
    for (const k of this.order) {
      const b = this.bars.get(k)!;
      if (b.closed) out.push(b);
    }
    return out;
  }

  /** the developing (not yet finalized) bar, if any */
  developing(): TvBar | null {
    const k = this.order.at(-1);
    if (k === undefined) return null;
    const b = this.bars.get(k)!;
    return b.closed ? null : b;
  }

  /** the most recent closed bar */
  lastClosed(): TvBar | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const b = this.bars.get(this.order[i])!;
      if (b.closed) return b;
    }
    return null;
  }

  /** first complete closed bar's minute ms (TV coverage start), or 0 */
  coverageStart(): number {
    for (const k of this.order) {
      const b = this.bars.get(k)!;
      if (b.source === "candle") return k;
    }
    return 0;
  }

  /** session buy − sell over all bars (the snapshot "day delta") */
  delta(): number {
    let d = 0;
    for (const b of this.bars.values()) d += b.buy - b.sell;
    return d;
  }
}

export function tvBarComplete(b: TvBar): boolean {
  return !b.partial && b.missing <= Math.max(TV_GAP_TOLERANCE, Math.floor(b.trades * 0.01));
}

export type TvQuoteSnap = {
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  settle: number | null;
  timestamp: string | null;
};

/** contract family from a Tradovate symbol: full-size NQ / ES only — a
 *  micro stream (MNQ/MES) has ~10× the contract count and would break
 *  every volume threshold, so it is never routed to a live buffer. */
export function tvFamily(sym: string | undefined): "nq" | "es" | null {
  if (!sym) return null;
  const s = sym.toUpperCase();
  if (/^NQ[FGHJKMNQUVXZ]\d{1,2}$/.test(s)) return "nq";
  if (/^ES[FGHJKMNQUVXZ]\d{1,2}$/.test(s)) return "es";
  return null;
}

function etDayOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
}

function etHour(ms: number): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ms)),
  ) % 24;
}

/** journal files that can hold the current Globex session: today's ET
 *  file, plus yesterday's when the session opened yesterday 18:00 ET. */
export function sessionJournalDays(nowMs: number): string[] {
  const today = etDayOf(nowMs);
  if (etHour(nowMs) >= 18) return [today];
  return [etDayOf(nowMs - 12 * 3_600_000), today].filter((d, i, a) => a.indexOf(d) === i);
}

/** Parse one journal line into ticks/quotes. Exported for tests. */
export function parseJournalLine(
  line: string,
): { wallMs: number; ticks: Array<{ sym: string; tk: TvRawTick }>; quotes: Array<{ sym: string; q: TvQuoteSnap }> } | null {
  // cheap pre-filter: only inbound chart/quote pushes matter (the journal
  // also carries heartbeats, outbound frames and histograms)
  if (!line.includes('"dir":"in"')) return null;
  const isChart = line.includes('"charts"');
  const isQuote = line.includes('"quotes"');
  if (!isChart && !isQuote) return null;
  let e: { t?: string; data?: { e?: string; d?: Record<string, unknown> } };
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  const wallMs = Date.parse(e.t ?? "") || 0;
  const d = e.data?.d ?? {};
  const ticks: Array<{ sym: string; tk: TvRawTick }> = [];
  const quotes: Array<{ sym: string; q: TvQuoteSnap }> = [];
  if (e.data?.e === "chart" && Array.isArray(d.charts)) {
    for (const c of d.charts as Array<Record<string, unknown>>) {
      const sym = typeof c.sym === "string" ? c.sym : "";
      if (!sym || !Array.isArray(c.tks) || typeof c.bp !== "number" || typeof c.bt !== "number") continue;
      for (const tk of decodeTvPacket(c as unknown as Parameters<typeof decodeTvPacket>[0])) ticks.push({ sym, tk });
    }
  } else if (e.data?.e === "md" && Array.isArray(d.quotes)) {
    for (const q of d.quotes as Array<Record<string, unknown>>) {
      const sym = typeof q.sym === "string" ? q.sym : "";
      if (!sym) continue;
      const en = (q.entries ?? {}) as Record<string, { price?: number; size?: number }>;
      quotes.push({
        sym,
        q: {
          ltp: en.Trade?.price ?? null,
          open: en.OpeningPrice?.price ?? null,
          high: en.HighPrice?.price ?? null,
          low: en.LowPrice?.price ?? null,
          volume: en.TotalTradeVolume?.size ?? null,
          settle: en.SettlementPrice?.price ?? null,
          timestamp: typeof q.timestamp === "string" ? q.timestamp : null,
        },
      });
    }
  }
  return { wallMs, ticks, quotes };
}

export type TvFeedStatus = {
  sessionDay: string;
  bootstrapped: boolean;
  files: string[];
  lastLineWallMs: number;
  nqSym: string | null;
  esSym: string | null;
  /** symbols seen in the journal that were NOT routed (micros, unknown) */
  ignoredSyms: string[];
};

/** The journal tailer + both builders. Module singleton via getTvFeed(). */
export class TvFeed {
  nq = new TvBarBuilder();
  es = new TvBarBuilder();
  nqQuote: TvQuoteSnap | null = null;
  esQuote: TvQuoteSnap | null = null;
  status: TvFeedStatus = {
    sessionDay: "",
    bootstrapped: false,
    files: [],
    lastLineWallMs: 0,
    nqSym: null,
    esSym: null,
    ignoredSyms: [],
  };
  private offsets = new Map<string, number>();
  private carry = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private listeners = new Set<() => void>();

  private dir: string;

  constructor(dir: string = process.env.TVMD_OUT ?? "./data/tradovate-md") {
    this.dir = dir;
  }

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private resetSession(day: string): void {
    this.nq.reset();
    this.es.reset();
    this.nqQuote = null;
    this.esQuote = null;
    this.offsets.clear();
    this.carry.clear();
    this.status = { ...this.status, sessionDay: day, bootstrapped: false, ignoredSyms: [] };
  }

  /** one tail pass over the session's journal files. Async + chunked so
   *  a cold-start replay of a full day never blocks the event loop. */
  async poll(nowMs: number = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const day = sessionDayOf(nowMs);
      if (day !== this.status.sessionDay) this.resetSession(day);
      const files = sessionJournalDays(nowMs).map((d) => `${this.dir}/md-${d}.jsonl`);
      this.status.files = files.map((f) => f.split("/").pop() ?? f);
      const revBefore = this.nq.revision + this.es.revision;
      for (const f of files) await this.tailFile(f, day);
      this.status.bootstrapped = true;
      this.nq.finalize(nowMs);
      this.es.finalize(nowMs);
      if (this.nq.revision + this.es.revision !== revBefore) for (const fn of this.listeners) fn();
    } catch (e) {
      console.log("[tvfeed] poll failed:", (e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
  }

  private async tailFile(file: string, day: string): Promise<void> {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    let off = this.offsets.get(file) ?? 0;
    if (size < off) {
      off = 0; // truncated/replaced — re-read
      this.carry.delete(file);
    }
    while (off < size) {
      const len = Math.min(READ_CHUNK, size - off);
      const buf = Buffer.alloc(len);
      const fd = openSync(file, "r");
      let n = 0;
      try {
        n = readSync(fd, buf, 0, len, off);
      } finally {
        closeSync(fd);
      }
      if (n <= 0) break;
      off += n;
      const text = (this.carry.get(file) ?? "") + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      this.carry.set(file, lines.pop() ?? "");
      for (const line of lines) this.ingestLine(line, day);
      this.offsets.set(file, off);
      if (off < size) await new Promise((r) => setImmediate(r)); // yield between chunks
    }
    this.offsets.set(file, off);
  }

  ingestLine(line: string, day: string): void {
    const p = parseJournalLine(line);
    if (!p) return;
    if (p.wallMs > this.status.lastLineWallMs) this.status.lastLineWallMs = p.wallMs;
    for (const { sym, tk } of p.ticks) {
      if (sessionDayOf(tk.t) !== day) continue;
      const fam = tvFamily(sym);
      if (!fam) {
        if (!this.status.ignoredSyms.includes(sym)) this.status.ignoredSyms.push(sym);
        continue;
      }
      if (fam === "nq") {
        this.status.nqSym = sym;
        this.nq.ingest(tk, p.wallMs);
      } else {
        this.status.esSym = sym;
        this.es.ingest(tk, p.wallMs);
      }
    }
    for (const { sym, q } of p.quotes) {
      const fam = tvFamily(sym);
      if (fam === "nq") this.nqQuote = q;
      else if (fam === "es") this.esQuote = q;
    }
  }
}

const g = globalThis as unknown as { __tvFeed?: TvFeed };

export function getTvFeed(): TvFeed {
  if (!g.__tvFeed) {
    g.__tvFeed = new TvFeed();
    g.__tvFeed.start();
  }
  return g.__tvFeed;
}
