/* ------------------------------------------------------------------ *
 * Live DOM_V2 (Level 2) feed + iceberg detector — server singleton.
 *
 * Reverse-engineered 2026-10-02 from the terminal's trades.worker bundle:
 * - DOM_V2 rides its OWN socket: wss://origin.wsdom.prodb.<dc>.gocharting.com/<dc>/ws
 *   (the trade/quote socket is origin.ws.<dc> — the wsdom one is dedicated).
 * - SUBSCRIBE {"command":"SUBSCRIBE","channel":"DOM_V2","payload":["CME:FUTURE:NQZ26"]}
 * - Frames are binary; a frame whose first byte is NOT 109 is zlib-deflated
 *   JSON of {channel:"DOM_V2", payload:{t:"s"|"d", seq, data}} (the 109 path
 *   is protobuf responses, only used by FOOTPRINT/V2 + TS/V2 on the main
 *   socket). payload/data can arrive double-encoded as JSON strings.
 * - snapshot data: {symbol,exchange,segment,bids:[{p,s}],asks:[{p,s}]}
 * - incremental data: {bids:[{a,p,s}],asks:[...]} — a="d" deletes the level.
 *
 * TWO instruments share the one subscription: NQ (the traded instrument) and
 * ES (the cross-asset context) — the vendor accepts a symbol array, and
 * snapshot/incremental rows carry the symbol they belong to. The ES front
 * month is derived from the NQ symbol (shared H/M/U/Z cycle) so no extra
 * env config is needed; GOCHARTING_SYMBOL_ES overrides when set.
 *
 * The book is aggregated per-price visible size (no order IDs), so hidden
 * resting orders are inferred by the refill heuristic in domBook.ts.
 *
 * OBSERVATIONAL ONLY: the only consumer outside this module is
 * signalFeed.record(), which stamps a read-only snapshot into each signal's
 * feature vector. Nothing here can change a signal.
 *
 * Personal use only — undocumented transport. Study aid, not a signal.
 * ------------------------------------------------------------------ */

import { inflateSync, inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DomBook,
  DEFAULT_DOM_ICEBERG,
  buildDomContext,
  compactCandidates,
  esSymbolFor,
  type DomIcebergConfig,
  type DomSignalContext,
  type IcebergCandidate,
} from "./domBook";
import { marketOpenAt } from "./marketHours";
import { persistDomRefills } from "./domStore";

type DomLevel = { p: number; s: number };

export type DomSymbolState = {
  symbol: string;
  snapshots: number;
  increments: number;
  lastSeq: number;
  book: { bids: DomLevel[]; asks: DomLevel[] };
  icebergs: IcebergCandidate[];
};

export type DomState = {
  connected: boolean;
  lastMessage: number;
  /** decoded DOM_V2 frames received in this process lifetime */
  frames: number;
  /** consecutive connections that delivered ZERO DOM_V2 frames — the
   *  vendor-dead detector (2026-10-07: the raw probe also gets nothing,
   *  so the feed stops reconnecting instead of flapping every ~4 min) */
  silentConnects: number;
  lastReconnectAt: number;
  nq: DomSymbolState;
  es: DomSymbolState;
};

export type DomSignalContextPair = {
  /** NQ candidates vs the ticket's entry/stop/target lines */
  nq: DomSignalContext;
  /** ES top candidates — logged for cross-asset evidence (no proximity logic:
   *  ES and NQ prices live on different scales) */
  es: { ts: number; candidates: ReturnType<typeof compactCandidates> };
};

const TOKEN_REFRESH_MS = 50 * 60_000;
const STALE_RECONNECT_MS = 180_000;
const EMIT_THROTTLE_MS = 1000;

function numEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** per-instrument detector tuning; ES = deeper book, bigger slices */
export function domIcebergConfig(prefix: "DOM_ICEBERG" | "DOM_ICEBERG_ES", base: Partial<DomIcebergConfig> = {}): Partial<DomIcebergConfig> {
  return {
    windowMs: numEnv(`${prefix}_WINDOW_MS`, 90_000),
    minRefills: numEnv(`${prefix}_MIN_REFILLS`, 3),
    minAbsorbed: numEnv(`${prefix}_MIN_ABSORBED`, 25),
    minRefillSize: numEnv(`${prefix}_MIN_REFILL_SIZE`, 2),
    ...base,
  };
}

export const ES_ICEBERG_DEFAULTS: Partial<DomIcebergConfig> = {
  ...DEFAULT_DOM_ICEBERG,
  minAbsorbed: 50, // ES trades ~2x NQ per level
  minRefillSize: 3,
};

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  // same local-dev fallback live.ts uses: credentials live in gcdata/.env
  const envPath = path.join(process.cwd(), "..", "gcdata", ".env");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const [k, ...rest] = s.split("=");
      out[k.trim()] = rest.join("=").trim();
    }
  } catch {
    /* no env file */
  }
  for (const k of ["GOCHARTING_EMAIL", "GOCHARTING_PASSWORD", "GOCHARTING_COGNITO_CLIENT", "GOCHARTING_DC", "GOCHARTING_SYMBOL", "GOCHARTING_SYMBOL_ES", "GOCHARTING_EXCHANGE", "GOCHARTING_SEGMENT"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

async function cognitoIdToken(env: Record<string, string>): Promise<string> {
  const body = {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: env.GOCHARTING_COGNITO_CLIENT,
    AuthParameters: { USERNAME: env.GOCHARTING_EMAIL, PASSWORD: env.GOCHARTING_PASSWORD },
  };
  const res = await fetch("https://cognito-idp.ap-south-1.amazonaws.com/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { AuthenticationResult?: { IdToken?: string } };
  const token = j.AuthenticationResult?.IdToken;
  if (!token) throw new Error("cognito: no IdToken in response");
  return token;
}

/** decode a wsdom binary frame into the DOM message object, or null. */
function decodeDomFrame(buf: ArrayBuffer): Record<string, unknown> | null {
  const b = new Uint8Array(buf);
  if (b.length === 0 || b[0] === 109) return null; // 109 = protobuf framing (other commands)
  let text: string;
  try {
    text = inflateSync(b).toString("utf-8");
  } catch {
    try {
      text = inflateRawSync(b).toString("utf-8");
    } catch {
      return null;
    }
  }
  try {
    const v: unknown = JSON.parse(text);
    return asRecord(v);
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** "CME:FUTURE:ESZ26" -> "ESZ26"; "ESZ26" -> "ESZ26" */
function bareSymbol(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const parts = v.split(":");
  return parts[parts.length - 1].trim().toUpperCase() || null;
}

class DomFeed {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private tokenFetchedAt = 0;
  private env: Record<string, string>;
  private listeners = new Set<(s: DomState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryMs = 10_000;
  private lastEmit = 0;
  private pendingEmit: ReturnType<typeof setTimeout> | null = null;
  private books: { nq: DomBook; es: DomBook };
  private symbols: { nq: string; es: string | null };
  private warnUnrouted = false;
  /** DOM_V2 frames on the CURRENT connection (reset every connect) */
  private framesThisConn = 0;
  /** last "vendor channel silent" console line (hourly throttle) */
  private lastSilentLog = 0;

  state: DomState = {
    connected: false,
    lastMessage: 0,
    frames: 0,
    silentConnects: 0,
    lastReconnectAt: 0,
    nq: { symbol: "", snapshots: 0, increments: 0, lastSeq: 0, book: { bids: [], asks: [] }, icebergs: [] },
    es: { symbol: "", snapshots: 0, increments: 0, lastSeq: 0, book: { bids: [], asks: [] }, icebergs: [] },
  };

  constructor() {
    this.env = loadEnv();
    const nq = this.env.GOCHARTING_SYMBOL || "NQZ26";
    const es = this.env.GOCHARTING_SYMBOL_ES || esSymbolFor(nq);
    this.symbols = { nq, es };
    this.state.nq.symbol = nq;
    this.state.es.symbol = es ?? "";
    this.books = {
      nq: new DomBook(domIcebergConfig("DOM_ICEBERG")),
      es: new DomBook(domIcebergConfig("DOM_ICEBERG_ES", ES_ICEBERG_DEFAULTS)),
    };
  }

  get esSymbol(): string | null {
    return this.symbols.es;
  }

  subscribe(fn: (s: DomState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  /** throttle: the DOM stream is high-frequency — emit at most ~1/s */
  private emit() {
    const now = Date.now();
    if (now - this.lastEmit < EMIT_THROTTLE_MS) {
      if (!this.pendingEmit) {
        this.pendingEmit = setTimeout(() => {
          this.pendingEmit = null;
          this.emitNow();
        }, EMIT_THROTTLE_MS);
      }
      return;
    }
    this.emitNow();
  }

  private emitNow() {
    this.lastEmit = Date.now();
    const now = Date.now();
    this.state.nq.icebergs = this.books.nq.detect(now);
    this.state.nq.book = this.books.nq.top(10);
    this.state.es.icebergs = this.books.es.detect(now);
    this.state.es.book = this.books.es.top(10);
    const s = this.state;
    for (const fn of this.listeners) fn(s);
  }

  private subscribeChannel() {
    try {
      const sym = `${this.env.GOCHARTING_EXCHANGE || "CME"}:${this.env.GOCHARTING_SEGMENT || "FUTURE"}:`;
      const payload = [sym + this.symbols.nq];
      if (this.symbols.es) payload.push(sym + this.symbols.es);
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "DOM_V2", payload }));
    } catch {
      /* ignore */
    }
  }

  /** which book does this message belong to? null = can't tell */
  private route(data: Record<string, unknown>, payload: Record<string, unknown>): "nq" | "es" | null {
    // the terminal resolves the key the same way: data.symbol first, then
    // productId/key, then (single subscription) the only symbol subscribed
    const bare = bareSymbol(data.symbol) ?? bareSymbol(payload.productId) ?? bareSymbol(payload.key);
    if (bare) {
      if (bare === bareSymbol(this.symbols.nq)) return "nq";
      if (this.symbols.es && bare === bareSymbol(this.symbols.es)) return "es";
      if (!this.warnUnrouted) {
        this.warnUnrouted = true;
        console.warn(`[dom] unrouted DOM_V2 message for ${bare} (have ${this.symbols.nq}${this.symbols.es ? ", " + this.symbols.es : ""})`);
      }
      return null;
    }
    if (!this.symbols.es) return "nq"; // single-symbol mode: assume NQ
    return null;
  }

  private handleText(msg: string) {
    this.state.lastMessage = Date.now();
    if (msg.startsWith("PING-")) {
      this.ws?.send("PONG-" + msg.slice(5));
      return;
    }
    if (msg.startsWith("Welcome-")) {
      this.state.connected = true;
      this.emitNow();
      return;
    }
    // EXCHANGE_STATUS and friends — nothing to do; lastMessage is already set
  }

  private handleBinary(buf: ArrayBuffer) {
    this.state.lastMessage = Date.now();
    const msg = decodeDomFrame(buf);
    if (!msg || msg.channel !== "DOM_V2") return;
    this.framesThisConn += 1;
    this.state.frames += 1;
    // payload and data can arrive double-encoded as JSON strings (the
    // terminal worker JSON.parses each layer separately — mirror it)
    let p: unknown = msg.payload;
    if (typeof p === "string") {
      try {
        p = JSON.parse(p);
      } catch {
        return;
      }
    }
    const payload = asRecord(p);
    if (!payload) return;
    let d: unknown = payload.data;
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        return;
      }
    }
    const data = asRecord(d);
    if (!data) return;
    const which = this.route(data, payload);
    if (!which) return;
    const t = payload.t;
    const seq = Number(payload.seq);
    const st = this.state[which];
    if (Number.isFinite(seq)) st.lastSeq = seq;
    if (t === "s") {
      this.books[which].applySnapshot(data as unknown as Parameters<DomBook["applySnapshot"]>[0]);
      st.snapshots += 1;
    } else if (t === "d") {
      this.books[which].applyIncremental(data as unknown as Parameters<DomBook["applyIncremental"]>[0], Date.now());
      st.increments += 1;
    }
    this.emit();
  }

  async connect() {
    try {
      if (!this.token || Date.now() - this.tokenFetchedAt > TOKEN_REFRESH_MS) {
        this.token = await cognitoIdToken(this.env);
        this.tokenFetchedAt = Date.now();
      }
      this.framesThisConn = 0;
      const dc = this.env.GOCHARTING_DC || "nyc1";
      // dedicated DOM socket: origin.ws. -> origin.wsdom. (keeps .prodb)
      const url = `wss://origin.wsdom.prodb.${dc}.gocharting.com/${dc}/ws?token=${this.token}&tag=${Date.now()}`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        this.retryMs = 10_000;
        this.state.connected = true;
        this.subscribeChannel();
        this.emitNow();
      };
      this.ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.handleText(ev.data);
        else if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data);
      };
      this.ws.onclose = () => {
        this.state.connected = false;
        if (this.framesThisConn === 0) this.state.silentConnects += 1;
        else this.state.silentConnects = 0;
        this.emitNow();
        this.retryMs = Math.min(120_000, Math.max(10_000, this.retryMs * 2));
        setTimeout(() => this.connect(), this.retryMs);
      };
      this.ws.onerror = () => {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      // auth failures must not hot-loop (Cognito lockout risk — see live.ts)
      this.retryMs = Math.min(300_000, Math.max(60_000, this.retryMs * 2));
      setTimeout(() => this.connect(), this.retryMs);
    }
  }

  start() {
    if (this.timer) return;
    this.connect();
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks += 1;
      const now = Date.now();
      // keep-alive (2026-10-16): the vendor idle-kills the DOM socket after
      // ~4 min of silence — one session accumulated 45 silent reconnects
      // from that alone. PING every 30s + re-assert the DOM_V2 subscription
      // every 60s, the same cadence the main feed keeps on its socket
      // (lib/live.ts). The channel itself still delivers nothing (vendor
      // side — probe-verified 2026-10-15/16 on both the wsdom and the main
      // ws hosts), so this stops the churn without inventing data.
      if (this.state.connected) {
        try {
          this.ws?.send(JSON.stringify({ command: "PING" }));
        } catch {
          /* ignore */
        }
        if (ticks % 2 === 0) this.subscribeChannel();
      }
      // staleness watchdog (mirrors live.ts): a silent DOM socket while the
      // market is open means the subscription died — force a reconnect
      const stale =
        this.state.connected &&
        this.state.lastMessage > 0 &&
        marketOpenAt(now) &&
        now - this.state.lastMessage > STALE_RECONNECT_MS;
      if (stale) {
        // vendor-dead detector (2026-10-07): a raw probe gets ZERO frames
        // from the wsdom DOM_V2 channel too — after 3 silent connections,
        // stop reconnecting (the every-4-min flap is pure noise) and say
        // so once an hour. The reconnect resumes automatically the moment
        // a connection ever delivers a frame again.
        if (this.framesThisConn === 0 && this.state.silentConnects >= 3) {
          if (now - this.lastSilentLog >= 3_600_000) {
            this.lastSilentLog = now;
            console.log("[dom] vendor DOM_V2 channel silent — reconnect suspended (check /api/gc?action=health → dom)");
          }
        } else {
          this.state.lastReconnectAt = now;
          console.log("[dom] forced reconnect — no DOM_V2 frames while market open");
          try {
            this.ws?.close(); // onclose → backoff reconnect → resubscribe
          } catch {
            /* ignore */
          }
        }
      }
      this.emitNow();
      // evidence heartbeat: one row per active candidate per instrument every
      // 60s while the signature holds (LIVE_WRITE-gated inside the store)
      if (ticks % 2 === 0 && this.state.connected) {
        if (this.state.nq.icebergs.length > 0) void persistDomRefills("NQ", this.state.nq.icebergs).catch(() => {});
        if (this.state.es.icebergs.length > 0) void persistDomRefills("ES", this.state.es.icebergs).catch(() => {});
      }
    }, 30_000);
  }
}

const g = globalThis as unknown as { __gcDom?: DomFeed };

export function getDom(): DomFeed {
  if (!g.__gcDom) {
    g.__gcDom = new DomFeed();
    g.__gcDom.start();
  }
  return g.__gcDom;
}

/**
 * The DOM picture to log with a signal: NQ candidates vs the ticket's
 * entry/stop/target lines + ES top candidates for cross-asset evidence.
 * PURELY observational — signalFeed stamps it into the signal's features;
 * nothing here can change a signal. Never throws.
 */
export function domContextForSignal(levels: {
  entry?: string | number | null;
  stop?: string | number | null;
  target?: string | number | null;
}): DomSignalContextPair | null {
  try {
    const dom = getDom();
    const now = Date.now();
    return {
      nq: buildDomContext(dom.state.nq.icebergs, levels, now),
      es: { ts: now, candidates: compactCandidates(dom.state.es.icebergs) },
    };
  } catch {
    return null;
  }
}
