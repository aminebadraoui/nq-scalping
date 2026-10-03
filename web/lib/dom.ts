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
 * The book is aggregated per-price visible size (no order IDs), so hidden
 * resting orders are inferred by the refill heuristic in domBook.ts.
 *
 * Personal use only — undocumented transport. Study aid, not a signal.
 * ------------------------------------------------------------------ */

import { inflateSync, inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DomBook, buildDomContext, type DomIcebergConfig, type DomSignalContext, type IcebergCandidate } from "./domBook";
import { marketOpenAt } from "./marketHours";
import { persistDomRefills } from "./domStore";

type DomLevel = { p: number; s: number };

export type DomState = {
  connected: boolean;
  lastMessage: number;
  snapshots: number;
  increments: number;
  lastSeq: number;
  book: { bids: DomLevel[]; asks: DomLevel[] };
  icebergs: IcebergCandidate[];
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

export function domIcebergConfig(): Partial<DomIcebergConfig> {
  return {
    windowMs: numEnv("DOM_ICEBERG_WINDOW_MS", 90_000),
    minRefills: numEnv("DOM_ICEBERG_MIN_REFILLS", 3),
    minAbsorbed: numEnv("DOM_ICEBERG_MIN_ABSORBED", 25),
    minRefillSize: numEnv("DOM_ICEBERG_MIN_REFILL_SIZE", 2),
  };
}

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
  for (const k of ["GOCHARTING_EMAIL", "GOCHARTING_PASSWORD", "GOCHARTING_COGNITO_CLIENT", "GOCHARTING_DC", "GOCHARTING_SYMBOL", "GOCHARTING_EXCHANGE", "GOCHARTING_SEGMENT"]) {
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
  private book: DomBook;

  state: DomState = {
    connected: false,
    lastMessage: 0,
    snapshots: 0,
    increments: 0,
    lastSeq: 0,
    book: { bids: [], asks: [] },
    icebergs: [],
  };

  constructor() {
    this.env = loadEnv();
    this.book = new DomBook(domIcebergConfig());
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
    this.state.icebergs = this.book.detect(Date.now());
    this.state.book = this.book.top(10);
    const s = this.state;
    for (const fn of this.listeners) fn(s);
  }

  private subscribeChannel() {
    try {
      const sym = `${this.env.GOCHARTING_EXCHANGE || "CME"}:${this.env.GOCHARTING_SEGMENT || "FUTURE"}:${this.env.GOCHARTING_SYMBOL || "NQZ26"}`;
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "DOM_V2", payload: [sym] }));
    } catch {
      /* ignore */
    }
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
    const t = payload.t;
    const seq = Number(payload.seq);
    if (Number.isFinite(seq)) this.state.lastSeq = seq;
    if (t === "s") {
      this.book.applySnapshot(data as unknown as Parameters<DomBook["applySnapshot"]>[0]);
      this.state.snapshots += 1;
    } else if (t === "d") {
      this.book.applyIncremental(data as unknown as Parameters<DomBook["applyIncremental"]>[0], Date.now());
      this.state.increments += 1;
    }
    this.emit();
  }

  async connect() {
    try {
      if (!this.token || Date.now() - this.tokenFetchedAt > TOKEN_REFRESH_MS) {
        this.token = await cognitoIdToken(this.env);
        this.tokenFetchedAt = Date.now();
      }
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
      // staleness watchdog (mirrors live.ts): a silent DOM socket while the
      // market is open means the subscription died — force a reconnect
      const now = Date.now();
      const stale =
        this.state.connected &&
        this.state.lastMessage > 0 &&
        marketOpenAt(now) &&
        now - this.state.lastMessage > STALE_RECONNECT_MS;
      if (stale) {
        console.log("[dom] forced reconnect — no DOM_V2 frames while market open");
        try {
          this.ws?.close(); // onclose → backoff reconnect → resubscribe
        } catch {
          /* ignore */
        }
      }
      this.emitNow();
      // evidence heartbeat: one row per active candidate every 60s while the
      // signature holds (best-effort, LIVE_WRITE-gated inside the store)
      if (ticks % 2 === 0 && this.state.connected && this.state.icebergs.length > 0) {
        void persistDomRefills(this.state.icebergs).catch(() => {});
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
 * The DOM picture to log with a signal: strongest live candidates plus how
 * they sit relative to the ticket's entry/stop/target lines. PURELY
 * observational — signalFeed stamps it into the signal's features; nothing
 * here can change a signal. Never throws.
 */
export function domContextForSignal(levels: {
  entry?: string | number | null;
  stop?: string | number | null;
  target?: string | number | null;
}): DomSignalContext | null {
  try {
    const dom = getDom();
    return buildDomContext(dom.state.icebergs, levels, Date.now());
  } catch {
    return null;
  }
}
