import { promises as fs } from "fs";
import path from "path";

/* ------------------------------------------------------------------ */
/* Live GoCharting feed (server-side singleton)                        */
/* Socket: wss://origin.ws.prodb.<dc>.gocharting.com/<dc>/ws           */
/* Personal use only — undocumented transport.                         */
/* ------------------------------------------------------------------ */

type Snapshot = {
  date: string;
  open: number;
  high: number;
  low: number;
  ltp: number;
  volume: number;
  prev_close: number;
  prev_date: string;
  s_type: string;
  delta: number;
};

export type Tick = {
  ms: number;
  ltp: number;
  size: number;
  side: 1 | -1;
};

export type LiveMinute = {
  t: string; // "HH:mm" UTC (ticks are keyed by UTC minute)
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  buy: number;
  sell: number;
  live: boolean; // built from ticks vs bootstrapped
  /** price (0.25-tick) -> [buy, sell] contracts — only kept for the recent minutes */
  levels?: Record<string, [number, number]>;
};

export type LiveState = {
  connected: boolean;
  lastMessage: number;
  snapshot: Snapshot | null;
  ticks: Tick[];
  minutes: LiveMinute[];
  cur: LiveMinute | null;
};

const TICK = 0.25;

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(process.cwd(), "..", "gcdata", ".env");
  try {
    const raw = require("fs").readFileSync(envPath, "utf8");
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
  const j = (await res.json()) as any;
  return j.AuthenticationResult.IdToken;
}

class LiveFeed {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private env: Record<string, string>;
  private listeners = new Set<(s: LiveState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLtp = 0;
  private retryMs = 10_000;
  /** staleness detection: the trade channel can go quiet while snapshots keep
   *  flowing (seen ~1h after connect — the 1-hour IdToken lifetime). If the
   *  market is demonstrably trading but no print arrives, force a reconnect
   *  with a fresh token + subscriptions. */
  private lastTradeMs = 0;
  private lastVol = -1;
  private lastVolChangeMs = 0;
  private lastForcedReconnectMs = 0;

  state: LiveState = {
    connected: false,
    lastMessage: 0,
    snapshot: null,
    ticks: [],
    minutes: [],
    cur: null,
  };

  constructor() {
    this.env = loadEnv();
  }

  subscribe(fn: (s: LiveState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const s = this.state;
    for (const fn of this.listeners) fn(s);
  }

  /** (re)assert the channel subscriptions — the server can silently drop a
   *  subscription while the socket stays up (observed: snapshots kept flowing
   *  but the trade channel went quiet, so live bars froze). */
  private subscribeChannels() {
    try {
      const sym = `${this.env.GOCHARTING_EXCHANGE || "CME"}:${this.env.GOCHARTING_SEGMENT || "FUTURE"}:${this.env.GOCHARTING_SYMBOL || "NQZ26"}`;
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "trade", payload: [sym] }));
      this.ws?.send(JSON.stringify({ command: "SUBSCRIBE", channel: "watchlist", payload: [sym] }));
    } catch {
      /* ignore */
    }
  }

  private minuteKey(ms: number) {
    const d = new Date(ms);
    return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  private applyTick(t: Tick) {
    const key = this.minuteKey(t.ms);
    const hhmm = key.slice(11, 16);
    let cur = this.state.cur;
    if (!cur || cur.t !== hhmm) {
      if (cur) this.state.minutes.push(cur);
      if (this.state.minutes.length > 480) this.state.minutes = this.state.minutes.slice(-480);
      // levels are only meaningful for the recent window — drop the rest
      for (let i = 0; i < this.state.minutes.length - 30; i++) delete this.state.minutes[i].levels;
      cur = { t: hhmm, o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, vol: 0, buy: 0, sell: 0, live: true };
      this.state.cur = cur;
    }
    cur.h = Math.max(cur.h, t.ltp);
    cur.l = Math.min(cur.l, t.ltp);
    cur.c = t.ltp;
    cur.vol += t.size;
    if (t.side === 1) cur.buy += t.size;
    else cur.sell += t.size;
    // per-price cluster so the live bar has a real footprint (bid x ask per tick)
    const px = Math.round(t.ltp / TICK) * TICK;
    const pxKey = px.toFixed(2);
    const lv = (cur.levels ??= {});
    const cell = lv[pxKey] ?? [0, 0];
    cell[t.side === 1 ? 0 : 1] += t.size;
    lv[pxKey] = cell;
    this.state.ticks.push(t);
    if (this.state.ticks.length > 2000) this.state.ticks = this.state.ticks.slice(-2000);
  }

  private handleText(msg: string) {
    if (msg.startsWith("PING-")) {
      this.ws?.send("PONG-" + msg.slice(5));
      return;
    }
    let j: any;
    try {
      j = JSON.parse(msg);
    } catch {
      return;
    }
    this.state.lastMessage = Date.now();
    if (j.channel === "snapshot" && j.payload) {
      const p = Object.values(j.payload)[0] as any;
      if (p) {
        this.state.snapshot = {
          date: p.date,
          open: p.open,
          high: p.high,
          low: p.low,
          ltp: p.ltp,
          volume: p.volume,
          prev_close: p.prev_close,
          prev_date: p.prev_date,
          s_type: p.s_type,
          delta: p.derived_values?.delta ?? 0,
        };
        // a moving day volume proves the market is trading (used to distinguish
        // a dropped subscription from a closed market)
        if (p.volume !== this.lastVol) {
          this.lastVol = p.volume;
          this.lastVolChangeMs = Date.now();
        }
        // keep the current minute's last price honest even without ticks
        if (!this.state.cur) {
          this.state.cur = { t: "now", o: p.ltp, h: p.high, l: p.low, c: p.ltp, vol: 0, buy: 0, sell: 0, live: true };
        }
        this.emit();
      }
    } else if (j.channel === "trade" && j.payload) {
      this.lastTradeMs = Date.now();
      const p = Object.values(j.payload)[0] as any;
      const items = Array.isArray(p) ? p : p?.items ?? p?.data ?? [];
      for (const d of items) {
        const ltp = Number(d.ltp ?? d.price ?? d.last_price ?? d.last);
        if (!Number.isFinite(ltp) || ltp <= 0) continue;
        // the trade channel carries the print size as `l_sz` (confirmed from the
        // 2026-09-28 session capture) — sizing every tick as 1 contract by
        // default would silently corrupt live volume and delta
        const size = Number(d.l_sz ?? d.quantity ?? d.qty ?? d.size ?? d.volume ?? d.last_qty ?? d.vol ?? 1);
        let side: 1 | -1;
        if (typeof d.side === "number") side = d.side >= 0 ? 1 : -1;
        else if (typeof d.side === "string") side = d.side.toLowerCase().startsWith("b") ? 1 : -1;
        else if (typeof d.aggressor_side === "string") side = d.aggressor_side.toLowerCase().startsWith("b") ? 1 : -1;
        else if (typeof d.buy !== "undefined") side = d.buy ? 1 : -1;
        else side = ltp >= this.lastLtp ? 1 : -1;
        this.lastLtp = ltp;
        this.applyTick({ ms: Date.parse(d.date ?? d.date_str ?? d.time ?? "") || Date.now(), ltp, size, side });
      }
      this.emit();
    } else if (j.channel === "watchlist" || j.channel === "positions" || j.channel === "chain") {
      // best-effort: same shape as trade
      const p = Object.values(j.payload || {})[0] as any;
      if (Array.isArray(p) && p.length && p[0].ltp) {
        const d = p[p.length - 1];
        this.lastLtp = Number(d.ltp);
        this.state.lastMessage = Date.now();
      }
    }
  }

  async connect() {
    try {
      if (!this.token) this.token = await cognitoIdToken(this.env);
      const dc = this.env.GOCHARTING_DC || "nyc1";
      const url = `wss://origin.ws.prodb.${dc}.gocharting.com/${dc}/ws?token=${this.token}&tag=${Date.now()}`;
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.state.connected = true;
        this.emit();
        this.subscribeChannels();
      };
      this.ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.handleText(ev.data);
        else if (ev.data instanceof ArrayBuffer) {
          const b = new Uint8Array(ev.data);
          try {
            const f = b[4];
            const txt = new TextDecoder().decode(b.subarray(5, 5 + f));
            const body = b.subarray(5 + f);
            if (txt.startsWith("FOOTPRINT/V2")) {
              // live-developing footprint frames: body is protobuf — skip in v1
            }
            this.state.lastMessage = Date.now();
          } catch {
            /* ignore */
          }
        }
      };
      this.ws.onclose = () => {
        this.state.connected = false;
        this.emit();
        // exponential backoff: a tight reconnect loop is what got the account
        // temporarily locked by Cognito ("Password attempts exceeded")
        this.retryMs = Math.min(120_000, Math.max(10_000, (this.retryMs ?? 10_000) * 2));
        setTimeout(() => this.connect(), this.retryMs);
      };
      this.ws.onerror = () => {
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      // 4xx (e.g. lockout) must not be retried fast — back off hard
      this.retryMs = Math.min(300_000, Math.max(60_000, (this.retryMs ?? 60_000) * 2));
      setTimeout(() => this.connect(), this.retryMs);
    }
  }

  start() {
    if (this.timer) return;
    this.connect();
    let ticks = 0;
    this.timer = setInterval(() => {
      if (this.state.connected) {
        this.ws?.send(JSON.stringify({ command: "PING", payload: {} }));
        ticks++;
        // re-assert the subscriptions once a minute: cheap, and it recovers a
        // silently dropped trade channel without waiting for a reconnect
        if (ticks % 12 === 0) this.subscribeChannels();
        // watchdog 1: no message at all for 5 minutes while "connected" means
        // the socket is dead but silent — force a reconnect
        const now = Date.now();
        const dead = this.state.lastMessage && now - this.state.lastMessage > 300_000;
        // watchdog 2: volume is moving (market open) but no print for 3 minutes
        // → the trade subscription has gone quiet; reconnect for a fresh token
        const tradesStale =
          this.lastVolChangeMs > 0 &&
          now - this.lastVolChangeMs < 120_000 &&
          this.lastTradeMs > 0 &&
          now - this.lastTradeMs > 180_000 &&
          now - this.lastForcedReconnectMs > 180_000;
        if (dead || tradesStale) {
          this.lastForcedReconnectMs = now;
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
        }
      }
      this.emit();
    }, 5000);
  }
}

const g = globalThis as unknown as { __gcLive?: LiveFeed };

export function getLive(): LiveFeed {
  if (!g.__gcLive) {
    g.__gcLive = new LiveFeed();
    g.__gcLive.start();
  }
  return g.__gcLive;
}
