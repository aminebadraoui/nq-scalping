/* ------------------------------------------------------------------ *
 * DOM_V2 book tracker + hidden-liquidity (iceberg) detector.
 *
 * The GoCharting DOM_V2 feed delivers an aggregated L2 book: per-price
 * visible size for bids and asks (snapshot {p,s} rows + {a,p,s} deltas).
 * Hidden resting orders are never visible — an iceberg shows only its
 * top slice — so detection is the classic REFILL heuristic (ATAS /
 * Bookmap style): a level whose visible size gets consumed and then
 * replenishes again and again without price trading through is being
 * refilled by a hidden order sitting behind it.
 *
 * Signals tracked per level (rolling window):
 *   consumed — total contracts removed from the level (it is being HIT)
 *   refills  — how many times size came back after being eaten
 *   refill amounts — consistency of the refill (an iceberg refills its
 *                    visible slice, so amounts repeat)
 *
 * A candidate = enough refills + enough absorbed volume in the window
 * while the level is still resting. PURE logic: no sockets, no I/O —
 * dom.ts feeds it messages, tests replay fixtures.
 *
 * Study aid, not an entry signal (project convention).
 * ------------------------------------------------------------------ */

export type DomLevelRow = { p: number; s: number };
export type DomDeltaRow = { a?: string; p: number; s: number };

export type DomSnapshotData = {
  symbol?: string;
  exchange?: string;
  segment?: string;
  bids: DomLevelRow[];
  asks: DomLevelRow[];
};

export type DomIncrementalData = {
  bids?: DomDeltaRow[];
  asks?: DomDeltaRow[];
};

export type IcebergCandidate = {
  side: "bid" | "ask";
  price: number;
  /** current visible size at the level */
  size: number;
  /** contracts consumed from the level inside the window */
  absorbed: number;
  /** refill events inside the window */
  refills: number;
  /** most common refill amount (the suspected visible slice) */
  refillSize: number;
  /** share of refills that matched refillSize (0..1) */
  refillConsistency: number;
  /** 0..1 — refills + absorbed volume + size consistency vs the tuning */
  confidence: number;
  lastRefillMs: number;
  /** total size ever seen on the level (rough hidden-order footprint) */
  peak: number;
};

export type DomIcebergConfig = {
  /** rolling window for refill accounting */
  windowMs: number;
  /** refills needed inside the window to be a candidate */
  minRefills: number;
  /** cumulative consumed contracts inside the window */
  minAbsorbed: number;
  /** refills below this size don't count (1-lot flicker) */
  minRefillSize: number;
  /** confidence weight for consistency vs volume vs count */
  wRefills: number;
  wAbsorbed: number;
  wConsistency: number;
};

export const DEFAULT_DOM_ICEBERG: DomIcebergConfig = {
  windowMs: 90_000,
  minRefills: 3,
  minAbsorbed: 25,
  minRefillSize: 2,
  wRefills: 0.4,
  wAbsorbed: 0.35,
  wConsistency: 0.25,
};

type LevelTrack = {
  size: number;
  peak: number;
  consumed: number;
  refills: number;
  /** refill amounts in the window, newest last */
  refillAmounts: number[];
  lastRefillMs: number;
  lastTouchMs: number;
  /** true when the last change was a decrease — a following increase is a refill */
  justConsumed: boolean;
};

const PX = 4; // price key: 0.25 ticks → quarter-cents, exact

function priceKey(p: number): number {
  return Math.round(p * PX);
}

export class DomBook {
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  snapshotReceived = false;
  seq = 0;
  config: DomIcebergConfig;
  private tracks = new Map<string, LevelTrack>();

  constructor(config: Partial<DomIcebergConfig> = {}) {
    this.config = { ...DEFAULT_DOM_ICEBERG, ...config };
  }

  private trackKey(side: "bid" | "ask", p: number): string {
    return `${side}|${priceKey(p)}`;
  }

  private track(side: "bid" | "ask", p: number): LevelTrack {
    const k = this.trackKey(side, p);
    let t = this.tracks.get(k);
    if (!t) {
      t = {
        size: 0,
        peak: 0,
        consumed: 0,
        refills: 0,
        refillAmounts: [],
        lastRefillMs: 0,
        lastTouchMs: 0,
        justConsumed: false,
      };
      this.tracks.set(k, t);
    }
    return t;
  }

  applySnapshot(data: DomSnapshotData): void {
    const set = (side: "bid" | "ask", rows: DomLevelRow[]) => {
      const book = side === "bid" ? this.bids : this.asks;
      book.clear();
      for (const r of rows) {
        const p = Number(r.p);
        const s = Number(r.s);
        if (!Number.isFinite(p) || !Number.isFinite(s) || s < 0) continue;
        book.set(priceKey(p), s);
        const t = this.track(side, p);
        t.size = s;
        t.peak = Math.max(t.peak, s);
      }
    };
    set("bid", data.bids ?? []);
    set("ask", data.asks ?? []);
    this.snapshotReceived = true;
  }

  applyIncremental(data: DomIncrementalData, nowMs: number): void {
    const apply = (side: "bid" | "ask", rows: DomDeltaRow[]) => {
      const book = side === "bid" ? this.bids : this.asks;
      for (const r of rows) {
        const p = Number(r.p);
        const s = Number(r.s);
        if (!Number.isFinite(p)) continue;
        const del = r.a === "d";
        if (del) {
          // removal counts as consumption of whatever was visible
          const prev = book.get(priceKey(p)) ?? 0;
          book.delete(priceKey(p));
          this.consume(side, p, Math.max(0, prev), nowMs);
          continue;
        }
        if (!Number.isFinite(s) || s < 0) continue;
        const k = priceKey(p);
        const prev = book.get(k) ?? 0;
        book.set(k, s);
        if (s > prev) this.refill(side, p, s - prev, s, nowMs);
        else if (s < prev) this.consume(side, p, prev - s, nowMs);
      }
    };
    apply("bid", data.bids ?? []);
    apply("ask", data.asks ?? []);
  }

  private consume(side: "bid" | "ask", p: number, qty: number, nowMs: number): void {
    if (qty <= 0) return;
    const t = this.track(side, p);
    t.size = Math.max(0, t.size - qty);
    t.consumed += qty;
    t.lastTouchMs = nowMs;
    t.justConsumed = true;
  }

  private refill(side: "bid" | "ask", p: number, amount: number, newSize: number, nowMs: number): void {
    const t = this.track(side, p);
    t.size = newSize;
    t.peak = Math.max(t.peak, newSize);
    t.lastTouchMs = nowMs;
    if (t.justConsumed && amount >= this.config.minRefillSize) {
      t.refills += 1;
      t.refillAmounts.push(amount);
      t.lastRefillMs = nowMs;
    }
    t.justConsumed = false;
  }

  /** prune windowed counters older than nowMs - windowMs */
  private prune(nowMs: number): void {
    const cut = nowMs - this.config.windowMs;
    if (cut <= 0) return;
    // tracks only age via refillAmounts; cheap enough to rebuild occasionally
    for (const [k, t] of this.tracks) {
      if (t.refills === 0 && t.consumed === 0) continue;
      // no per-event timestamps for consumption — decay when the level has
      // been quiet for the whole window
      if (t.lastTouchMs > 0 && t.lastTouchMs < cut && t.lastRefillMs < cut) {
        t.consumed = 0;
        t.refills = 0;
        t.refillAmounts = [];
        t.justConsumed = false;
        if (t.size <= 0) this.tracks.delete(k);
      }
    }
  }

  /** candidates at `nowMs`, sorted by confidence desc */
  detect(nowMs: number): IcebergCandidate[] {
    this.prune(nowMs);
    const out: IcebergCandidate[] = [];
    const { minRefills, minAbsorbed } = this.config;
    for (const [k, t] of this.tracks) {
      if (t.refills < minRefills || t.consumed < minAbsorbed || t.size <= 0) continue;
      const side = k.startsWith("bid|") ? "bid" : "ask";
      const p = Number(k.slice(4)) / PX;
      const counts = new Map<number, number>();
      for (const a of t.refillAmounts) counts.set(a, (counts.get(a) ?? 0) + 1);
      let mode = 0;
      let modeN = 0;
      for (const [a, n] of counts) {
        if (n > modeN || (n === modeN && a > mode)) {
          mode = a;
          modeN = n;
        }
      }
      const consistency = t.refillAmounts.length ? modeN / t.refillAmounts.length : 0;
      const c = this.config;
      const conf =
        c.wRefills * Math.min(1, (t.refills - minRefills + 1) / 4) +
        c.wAbsorbed * Math.min(1, t.consumed / (minAbsorbed * 2)) +
        c.wConsistency * consistency;
      out.push({
        side,
        price: p,
        size: t.size,
        absorbed: t.consumed,
        refills: t.refills,
        refillSize: mode,
        refillConsistency: consistency,
        confidence: Math.round(conf * 100) / 100,
        lastRefillMs: t.lastRefillMs,
        peak: t.peak,
      });
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  /** top N levels per side as display rows (best first) */
  top(n: number): { bids: { p: number; s: number }[]; asks: { p: number; s: number }[] } {
    const row = (m: Map<number, number>, dir: 1 | -1) =>
      [...m.entries()]
        .sort((a, b) => dir * (a[0] - b[0]))
        .slice(0, n)
        .map(([k, s]) => ({ p: k / PX, s }));
    return { bids: row(this.bids, -1), asks: row(this.asks, 1) };
  }
}

/* ------------------------------------------------------------------ *
 * Signal-time DOM context — a PURE snapshot builder.
 *
 * The feed logs its iceberg picture alongside EVERY recorded signal so
 * the self-improvement loop can later test whether hidden liquidity near
 * the entry/stop/target lines carried any predictive value. Purely
 * observational: nothing here can affect a signal.
 * ------------------------------------------------------------------ */

export type CompactCandidate = {
  side: "bid" | "ask";
  price: number;
  size: number;
  refillSize: number;
  refills: number;
  absorbed: number;
  consistency: number;
  confidence: number;
};

export type DomSignalContext = {
  ts: number;
  /** strongest candidates at signal time (top 5, compact) */
  candidates: CompactCandidate[];
  /** candidates resting within nearPts of the entry line */
  nearEntry: CompactCandidate[];
  /** candidates resting within nearPts of the stop (invalidation) line */
  nearStop: CompactCandidate[];
  /** candidates resting within nearPts of the target line */
  nearTarget: CompactCandidate[];
};

const compact = (c: IcebergCandidate[]): CompactCandidate[] =>
  c.slice(0, 5).map((x) => ({
    side: x.side,
    price: x.price,
    size: x.size,
    refillSize: x.refillSize,
    refills: x.refills,
    absorbed: x.absorbed,
    consistency: x.refillConsistency,
    confidence: x.confidence,
  }));

/** compact a candidate list for logging (max 5, detector internals dropped) */
export function compactCandidates(c: IcebergCandidate[]): CompactCandidate[] {
  return compact(c);
}

/**
 * Build the DOM context to log with a signal. `levels` come from the ticket
 * strings (entry/stop/target) — anything unparseable is ignored. Never throws.
 */
export function buildDomContext(
  candidates: IcebergCandidate[],
  levels: { entry?: string | number | null; stop?: string | number | null; target?: string | number | null },
  nowMs = Date.now(),
  nearPts = 1.0,
): DomSignalContext {
  const num = (v: string | number | null | undefined): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const entry = num(levels.entry);
  const stop = num(levels.stop);
  const target = num(levels.target);
  const near = (lvl: number | null) =>
    lvl === null ? [] : compactCandidates(candidates.filter((c) => Math.abs(c.price - lvl) <= nearPts));
  return {
    ts: nowMs,
    candidates: compactCandidates(candidates),
    nearEntry: near(entry),
    nearStop: near(stop),
    nearTarget: near(target),
  };
}

/**
 * ES front month from the NQ symbol: both run the same quarterly cycle
 * (H/M/U/Z, 3rd-Friday expiry), so front months always match letter + year.
 * "NQZ26" -> "ESZ26". Null when the NQ symbol doesn't parse.
 */
export function esSymbolFor(nq: string): string | null {
  const m = /^NQ([HMUZ])(\d{2})$/i.exec(nq.trim());
  if (!m) return null;
  return `ES${m[1].toUpperCase()}${m[2]}`;
}
