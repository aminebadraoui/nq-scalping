/* ------------------------------------------------------------------ *
 * Pure protocol helpers for the Tradovate WebSocket market-data API.
 *
 * Frame format (verified against the official tradovate/example-api-js
 * SDK, EX-10a-Chart-Data-Solution/src/TradovateSocket.js):
 *   - server → client text frames start with a one-char type tag:
 *       'o'  open/heartbeat prompt  → client answers by authorizing
 *       'h'  heartbeat prompt       → client answers with '[]'
 *       'a'  array of response/event items [{i, s, d}]  (i = request
 *            id, s = HTTP-like status, 200 = success, absent i =
 *            unsolicited push, e.g. {e:'md', d:{quotes/doms/...}})
 *       'c'  server closing the connection
 *   - client → server requests: `${endpoint}\n${id}\n${query}\n${body}`
 *     where body is JSON. `authorize` takes the token as its body:
 *     classic API-program tokens are a JSON-stringified string, but
 *     Google-SSO JWTs must be sent RAW (unquoted) — the platform's own
 *     frames carry the bare JWT, and the server 401s the quoted form.
 *     Endpoint names are lowercase, as the official SDK sends them:
 *     md/subscribequote, md/subscribedom, md/subscribehistogram,
 *     md/getchart, md/cancelchart, ...
 *   - the client must keep answering heartbeat prompts with '[]';
 *     the server drops a connection that is silent for ~15 s.
 *
 * No network access here — only scripts/tradovateMd.ts opens sockets.
 * ------------------------------------------------------------------ */

export interface TvItem {
  /** request id this item answers; absent on unsolicited events */
  i?: number;
  /** HTTP-like status; 200 = success */
  s?: number;
  /** event type tag on pushes, e.g. 'md' */
  e?: string;
  d?: unknown;
}

export interface TvFrame {
  type: string;
  data: TvItem[];
}

/** Encode a request frame exactly as the official SDK does. */
export function encodeRequest(endpoint: string, id: number, body: unknown, query = ""): string {
  return `${endpoint}\n${id}\n${query}\n${JSON.stringify(body)}`;
}

/** Split one raw server text frame into its type tag + parsed items.
 *  'o'/'h'/'c' frames carry no payload (or a bare '[]'); 'a' frames
 *  carry an array of items — a lone item is still wrapped as [item].
 *  Unparseable payloads degrade to an empty item list, never throw. */
export function parseFrame(raw: unknown): TvFrame {
  const s = typeof raw === "string" ? raw : String(raw);
  if (s.length === 0) return { type: "", data: [] };
  const type = s[0];
  if (s.length === 1) return { type, data: [] };
  let data: TvItem[] = [];
  try {
    const parsed: unknown = JSON.parse(s.slice(1));
    data = Array.isArray(parsed) ? (parsed as TvItem[]) : [parsed as TvItem];
  } catch {
    data = [];
  }
  return { type, data };
}

/** Same cadence the official SDK uses: when nothing arrived for 2.5 s,
 *  the client sends '[]' (independent of answering 'h' prompts). */
export const HEARTBEAT_INTERVAL_MS = 2500;

/** true once HEARTBEAT_INTERVAL_MS has passed since our last `[]` SENT
 *  (callers pass the send time — keying on inbound frames starves the
 *  heartbeat while the server is pushing data) */
export function shouldSendHeartbeat(nowMs: number, lastSentAtMs: number): boolean {
  return nowMs - lastSentAtMs >= HEARTBEAT_INTERVAL_MS;
}

export interface TvPenalty {
  ticket: unknown;
  time: number;
  captcha?: unknown;
}

/** Tradovate answers rate-limited requests with p-ticket/p-time (a
 *  retry-after ticket) or p-captcha. The caller waits `time` seconds
 *  and resends with the ticket merged into the body. */
export function penaltyOf(d: unknown): TvPenalty | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (o["p-ticket"] === undefined && o["p-time"] === undefined) return null;
  return {
    ticket: o["p-ticket"],
    time: typeof o["p-time"] === "number" ? o["p-time"] : Number(o["p-time"]) || 0,
    captcha: o["p-captcha"],
  };
}

export function isSuccess(item: TvItem): boolean {
  return item.s === 200;
}

/** Best-effort human-readable reason for a failed response item. */
export function errorTextOf(item: TvItem): string {
  const d = item.d as Record<string, unknown> | undefined;
  if (!d) return JSON.stringify(item);
  if (typeof d.errorText === "string" && d.errorText) return d.errorText;
  if (typeof d.message === "string" && d.message) return d.message;
  return JSON.stringify(d);
}

/** The §7 footprint recipe's live tick stream: a Tick chart, one tick
 *  per element, wrapping the most recent `asMuchAsElements` elements
 *  of history and then streaming. Schema per the partner request
 *  reference (timeRange needs ≥1 optional field). */
export function tickChartBody(symbol: string, asMuchAsElements: number): Record<string, unknown> {
  return {
    symbol,
    chartDescription: {
      underlyingType: "Tick",
      elementSize: 1,
      elementSizeUnit: "UnderlyingUnits",
      withHistogram: false,
    },
    timeRange: { asMuchAsElements },
  };
}
