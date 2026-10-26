/* ------------------------------------------------------------------ *
 * Reader for the Tradovate md JSONL journal (web/scripts/tradovateMd.ts).
 *
 * The collector appends one JSON line per frame to
 * data/tradovate-md/md-<ET-day>.jsonl:
 *   {"dir":"out","t":...,"frame":"authorize\n1\n\n<token>"}
 *   {"dir":"in","t":...,"type":"a","data":{...}}   // quote/hist/chart
 *
 * This module keeps an in-memory mirror (module singleton — lives for
 * the dev-server process) and re-reads only the bytes appended since
 * the last call. Tick-chart packets are decoded (time = bt + t,
 * price = (bp + p) × tickSize) into per-price × per-time-bucket
 * footprint cells with aggressor classification against the tick's own
 * bid/ask (docs/TRADOVATE-MARKET-DATA-RESEARCH.md §7). History packets
 * are deduped by tick id so reconnects don't double-count.
 * ------------------------------------------------------------------ */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emptyStatus, type RecapStatus } from "./tvmdRecap";

const TICK_SIZE = Number(process.env.TVMD_TICK_SIZE ?? 0.25); // MNQ
const BUCKET_MS = 15_000; // footprint column width
const MAX_COLUMNS = 48; // 12 min of footprint on screen
const MAX_TICKS = 8_000; // decoded tick ring
const MAX_TAPE = 60; // tape rows served
const MAX_SEEN_IDS = 40_000;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface TvQuote {
  contractId: number;
  timestamp: string;
  entries: Record<string, { price?: number; size?: number }>;
}
export interface TvHist {
  contractId: number;
  timestamp: string;
  base: number;
  items: Record<string, number>;
  refresh?: boolean;
}
export interface TvTick {
  t: number; // ms epoch
  price: number;
  size: number;
  bid: number | null; // bid price at trade time
  ask: number | null; // ask price at trade time
  bs: number | null;
  as: number | null;
  id: number | null;
}

interface FootprintCell {
  bv: number;
  av: number;
}

interface Packet {
  bp: number;
  bt: number;
  ts?: number;
  tks: Array<{ t: number; p: number; s: number; b?: number; a?: number; bs?: number; as?: number; id?: number }>;
}

function etDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function dataDir(): string {
  return process.env.TVMD_OUT ?? "./data/tradovate-md";
}

const state = {
  day: "",
  offset: 0,
  carry: "",
  quotes: new Map<number, TvQuote>(),
  hists: new Map<number, TvHist>(),
  lastContractId: null as number | null,
  ticks: [] as TvTick[],
  /** full-day tick history ({t, price}, capped) — the ring above is
   *  recent-only; the signal-time audit backfills older signals from
   *  this list when the ring has moved past them. */
  historic: [] as { t: number; price: number }[],
  seenTickIds: new Set<number>(),
  cols: [] as { t0: number; t1: number }[],
  cells: new Map<number, Map<number, FootprintCell>>(), // price -> bucketNum -> cell
  frameCount: 0,
  tickCount: 0,
  lastFrameTs: null as string | null,
};

function resetAll(): void {
  state.offset = 0;
  state.carry = "";
  state.quotes.clear();
  state.hists.clear();
  state.lastContractId = null;
  state.ticks = [];
  state.historic = [];
  state.seenTickIds.clear();
  state.cols = [];
  state.cells.clear();
  state.frameCount = 0;
  state.tickCount = 0;
  state.lastFrameTs = null;
}

function classify(tk: TvTick): "buy" | "sell" {
  if (tk.ask !== null && tk.price >= tk.ask) return "buy";
  if (tk.bid !== null && tk.price <= tk.bid) return "sell";
  if (tk.bid !== null && tk.ask !== null) {
    return tk.price - tk.bid <= tk.ask - tk.price ? "sell" : "buy";
  }
  return "buy";
}

function ingestTick(tk: TvTick): void {
  if (tk.id !== null) {
    if (state.seenTickIds.has(tk.id)) return;
    state.seenTickIds.add(tk.id);
    if (state.seenTickIds.size > MAX_SEEN_IDS) {
      // trim: keep ids from the surviving tail of the tick ring
      const keep = new Set<number>();
      for (const t of state.ticks.slice(-MAX_TICKS)) if (t.id !== null) keep.add(t.id);
      state.seenTickIds = keep;
    }
  }
  state.ticks.push(tk);
  state.tickCount++;
  if (state.ticks.length > MAX_TICKS) state.ticks = state.ticks.slice(-MAX_TICKS);
  state.historic.push({ t: tk.t, price: tk.price });
  if (state.historic.length > 150_000) state.historic = state.historic.slice(-150_000);

  const bucketNum = Math.floor(tk.t / BUCKET_MS);
  let colIdx = state.cols.findIndex((c) => c.t0 === bucketNum * BUCKET_MS);
  if (colIdx === -1) {
    state.cols.push({ t0: bucketNum * BUCKET_MS, t1: bucketNum * BUCKET_MS + BUCKET_MS });
    if (state.cols.length > MAX_COLUMNS) state.cols.shift();
  }
  let byBucket = state.cells.get(tk.price);
  if (!byBucket) {
    byBucket = new Map();
    state.cells.set(tk.price, byBucket);
  }
  const cell = byBucket.get(bucketNum) ?? { bv: 0, av: 0 };
  if (classify(tk) === "buy") cell.bv += tk.size;
  else cell.av += tk.size;
  byBucket.set(bucketNum, cell);
}

function decodePacket(p: Packet): TvTick[] {
  const ts = p.ts ?? TICK_SIZE;
  return p.tks.map((k) => ({
    t: p.bt + k.t,
    price: round2((p.bp + k.p) * ts),
    size: k.s,
    bid: k.b !== undefined ? round2((p.bp + k.b) * ts) : null,
    ask: k.a !== undefined ? round2((p.bp + k.a) * ts) : null,
    bs: k.bs ?? null,
    as: k.as ?? null,
    id: k.id ?? null,
  }));
}

/** Tick in a (roughly ascending) list closest to tsMs — scan from the
 *  end; rings are small (≤8k) and callers are rare (one per signal). */
export function nearestTickIn(ticks: TvTick[], tsMs: number): TvTick | null {
  let best: TvTick | null = null;
  let bestD = Infinity;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const d = Math.abs(ticks[i].t - tsMs);
    if (d < bestD) {
      bestD = d;
      best = ticks[i];
    } else if (ticks[i].t < tsMs - bestD) {
      break; // sorted-enough: only gets farther
    }
  }
  return bestD <= 60_000 ? best : null;
}

/** Tick from the live Tradovate ring closest to tsMs (null when the
 *  ring no longer spans that instant). */
export function nearestLiveTick(tsMs: number): TvTick | null {
  return nearestTickIn(state.ticks, tsMs);
}

/** Tick from the full-day history closest to tsMs (null when the
 *  history doesn't span that instant or nothing is within windowMs). */
export function nearestHistoricTick(tsMs: number, windowMs = 10_000): { t: number; price: number } | null {
  const list = state.historic;
  let best: { t: number; price: number } | null = null;
  let bestD = Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = Math.abs(list[i].t - tsMs);
    if (d < bestD) {
      bestD = d;
      best = list[i];
    } else if (list[i].t < tsMs - bestD) {
      break;
    }
  }
  return bestD <= windowMs ? best : null;
}

/** Span of the day-history tick list (diagnostics for the audit). */
export function historicRange(): { count: number; first: number | null; last: number | null } {
  return {
    count: state.historic.length,
    first: state.historic.length ? state.historic[0].t : null,
    last: state.historic.length ? state.historic[state.historic.length - 1].t : null,
  };
}

function handleData(data: Record<string, unknown>): void {
  const d = (data.d ?? {}) as Record<string, unknown>;
  if (data.e === "md") {
    const quotes = d.quotes as TvQuote[] | undefined;
    if (Array.isArray(quotes) && quotes.length) {
      for (const q of quotes) state.quotes.set(q.contractId, q);
      state.lastContractId = quotes[0].contractId;
    }
    const hists = d.histograms as TvHist[] | undefined;
    if (Array.isArray(hists) && hists.length) {
      for (const h of hists) {
        // histogram frames are per-price DELTA snapshots: items carry the
        // current cumulative volume only for changed prices — merge, never
        // replace, or the profile collapses to the last few changed levels.
        const existing = state.hists.get(h.contractId);
        if (existing) {
          state.hists.set(h.contractId, {
            ...existing,
            timestamp: h.timestamp,
            base: h.base,
            items: { ...existing.items, ...h.items },
          });
        } else {
          state.hists.set(h.contractId, h);
        }
      }
    }
  } else if (data.e === "chart") {
    const charts = d.charts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(charts)) {
      for (const c of charts) {
        const tks = c.tks;
        if (Array.isArray(tks)) for (const tk of decodePacket(c as unknown as Packet)) ingestTick(tk);
      }
    }
  }
}

function refresh(): void {
  const day = etDay();
  const file = `${dataDir()}/md-${day}.jsonl`;
  if (!existsSync(file)) {
    if (state.day !== day) {
      state.day = day;
      resetAll();
    }
    return;
  }
  const size = statSync(file).size;
  if (state.day !== day || size < state.offset) {
    state.day = day;
    resetAll();
  }
  if (size === state.offset) return;

  let chunk = "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - state.offset);
    const n = readSync(fd, buf, 0, buf.length, state.offset);
    chunk = buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
  state.offset = size;

  const text = state.carry + chunk;
  const lines = text.split("\n");
  state.carry = lines.pop() ?? ""; // keep any partial trailing line
  for (const line of lines) {
    if (!line) continue;
    let entry: { dir?: string; type?: string; t?: string; data?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.dir !== "in" || entry.type !== "a" || !entry.data) continue;
    state.frameCount++;
    state.lastFrameTs = entry.t ?? null;
    handleData(entry.data);
  }
}

export interface TvmdSnapshot {
  ok: boolean;
  day: string;
  file: string;
  contractId: number | null;
  quote: TvQuote | null;
  profile: { price: number; vol: number }[];
  columns: { t0: number; t1: number }[];
  footprint: { price: number; cells: ({ bv: number; av: number } | null)[] }[];
  tape: { t: number; price: number; size: number; side: "buy" | "sell" }[];
  stats: { frames: number; ticks: number; lastFrame: string | null };
  /** masked info about the session token the collector is using, plus
   *  the autoheal loop's status (Google-session health) */
  token: {
    prefix: string;
    renewedAt: string | null;
    anchoredAt: string | null;
    recap: RecapStatus | null;
  } | null;
}

/* -------------------- session token persistence -------------------- */
/* Shared with the collector via the volume: the API writes a fresh
 * pasted token here, the collector watches the file's mtime and
 * hot-restarts with it (see scripts/tradovateMd.ts). */

function tokenFilePath(): string {
  return process.env.TVMD_TOKEN_FILE ?? "./data/.tradovate-md-token.json";
}

export interface TvmdTokenInfo {
  prefix: string;
  renewedAt: string | null;
  anchoredAt: string | null;
  recap: RecapStatus | null;
}

/** Autoheal status file written by the recapture loop — same default
 *  derivation as scripts/tvmdRecapture.ts (next to the token file).
 *  Absent until the loop runs. */
function recapStatusFile(): string {
  return process.env.TVMD_RECAP_STATUS ?? path.join(path.dirname(tokenFilePath()), ".recap-status.json");
}

function readRecapStatus(): RecapStatus | null {
  try {
    const raw = JSON.parse(readFileSync(recapStatusFile(), "utf8")) as Partial<RecapStatus>;
    return { ...emptyStatus(), ...raw };
  } catch {
    return null;
  }
}

export function tokenInfo(): TvmdTokenInfo | null {
  try {
    const raw = JSON.parse(readFileSync(tokenFilePath(), "utf8")) as { token?: unknown; renewedAt?: unknown; anchoredAt?: unknown };
    if (typeof raw.token !== "string" || !raw.token) return null;
    return {
      prefix: `${raw.token.slice(0, 8)}…`,
      renewedAt: typeof raw.renewedAt === "string" ? raw.renewedAt : null,
      anchoredAt: typeof raw.anchoredAt === "string" ? raw.anchoredAt : null,
      recap: readRecapStatus(),
    };
  } catch {
    return null;
  }
}

/** Persist a freshly pasted session token. Returns false when the
 *  string doesn't look like a Tradovate SSO JWT. */
export function persistToken(token: string): boolean {
  if (!/^eyJ[^.]+\.eyJ[^.]+\./.test(token) || token.length < 80 || token.length > 8000) return false;
  writeFileSync(tokenFilePath(), JSON.stringify({ token, renewedAt: new Date().toISOString() }, null, 2));
  return true;
}

export function getSnapshot(): TvmdSnapshot {
  refresh();
  const cid = state.lastContractId;
  const quote = cid !== null ? (state.quotes.get(cid) ?? null) : null;
  const hist = cid !== null ? (state.hists.get(cid) ?? null) : null;

  // footprint rows: traded prices, highest first
  const prices = new Set<number>();
  for (const p of state.cells.keys()) prices.add(p);
  const rows = [...prices].sort((a, b) => b - a);

  const cols = state.cols;
  const footprint = rows.map((price) => {
    const byBucket = state.cells.get(price);
    return {
      price,
      cells: cols.map((c) => (byBucket ? (byBucket.get(c.t0 / BUCKET_MS) ?? null) : null)),
    };
  });

  const profile: { price: number; vol: number }[] = [];
  if (hist) {
    for (const [offset, vol] of Object.entries(hist.items)) {
      profile.push({ price: round2(hist.base + Number(offset) * TICK_SIZE), vol });
    }
  }
  profile.sort((a, b) => b.price - a.price);

  const tape = state.ticks
    .slice(-MAX_TAPE)
    .reverse()
    .map((tk) => ({ t: tk.t, price: tk.price, size: tk.size, side: classify(tk) }));

  return {
    ok: true,
    day: state.day,
    file: `md-${state.day}.jsonl`,
    contractId: cid,
    quote,
    profile,
    columns: cols,
    footprint,
    tape,
    stats: { frames: state.frameCount, ticks: state.tickCount, lastFrame: state.lastFrameTs },
    token: tokenInfo(),
  };
}
