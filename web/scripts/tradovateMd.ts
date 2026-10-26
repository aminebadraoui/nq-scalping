/* ------------------------------------------------------------------ *
 * Tradovate market-data collector — replays the app's md WebSocket
 * session on the computer.
 *
 * Connects to the Tradovate market-data socket (live wss://md.tradovate
 * api.com / demo wss://md-demo.tradovateapi.com), authorizes with a
 * captured access token, and subscribes to the same streams the iOS/web
 * app uses: quote, volume histogram, tick chart (§2 of
 * docs/TRADOVATE-MARKET-DATA-RESEARCH.md). Every frame — outbound
 * requests and inbound responses/pushes — is appended to a per-day
 * JSONL file for the footprint pipeline to consume later.
 *
 * The token is captured, not generated: Google-SSO accounts have no
 * password to re-authenticate with, so when the token chain finally
 * breaks, re-capture (docs/TRADOVATE-CAPTURE-GUIDE.md) and set
 * TVMD_TOKEN again. Successful renewals are persisted to
 * TVMD_TOKEN_FILE so restarts stay warm.
 *
 * Usage (from web/):
 *   node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts
 *
 * NOTE: this is a data-collection research tool for your own account.
 * It is not live-execution code and never places orders.
 * ------------------------------------------------------------------ */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import {
  errorTextOf,
  encodeRequest,
  HEARTBEAT_INTERVAL_MS,
  isSuccess,
  parseFrame,
  penaltyOf,
  shouldSendHeartbeat,
  tickChartBody,
  type TvFrame,
  type TvItem,
} from "../lib/tradovateMdProtocol";

/* ----------------------------- config ----------------------------- */

interface Config {
  env: "live" | "demo";
  mdHost: string;
  tradeHost: string;
  restHost: string;
  token: string;
  tokenFile: string;
  symbols: string[];
  subs: { quote: boolean; hist: boolean; chart: boolean };
  chartElements: number;
  outDir: string;
  quiet: boolean;
  debug: boolean;
  summaryMs: number;
  transport: "ws" | "http";
  sinkPort: number;
}

const DEFAULT_HOSTS = {
  live: {
    md: "wss://md.tradovateapi.com/v1/websocket",
    trade: "wss://live.tradovateapi.com/v1/websocket",
  },
  demo: {
    md: "wss://md-demo.tradovateapi.com/v1/websocket",
    trade: "wss://demo.tradovateapi.com/v1/websocket",
  },
} as const;

// same .env.local convention as scripts/importTradovateTrades.ts
function loadDotEnv(): void {
  try {
    const envFile = readFileSync(".env.local", "utf8");
    for (const line of envFile.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const key = s.slice(0, i).trim();
      if (!process.env[key]) process.env[key] = s.slice(i + 1).trim();
    }
  } catch {
    /* no .env.local — env vars only */
  }
}

function readTokenFile(path: string): string {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown; renewedAt?: string };
    return typeof raw.token === "string" ? raw.token : "";
  } catch {
    return "";
  }
}

function writeTokenFile(path: string, token: string): void {
  try {
    // keep the recapture loop's anchoredAt (last fresh login): dropping
    // it on renewal makes the loop think the session was never anchored
    // and re-login after every 20-min renewal
    let anchoredAt: string | undefined;
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as { anchoredAt?: unknown };
      if (typeof prev.anchoredAt === "string") anchoredAt = prev.anchoredAt;
    } catch {
      /* first write */
    }
    writeFileSync(path, JSON.stringify({ token, renewedAt: new Date().toISOString(), ...(anchoredAt ? { anchoredAt } : {}) }, null, 2));
    // record our own write so the hot-swap watcher ignores it
    try {
      tokenFileMtime = statSync(path).mtimeMs;
    } catch {
      /* ignore */
    }
  } catch (e) {
    logErr(`could not persist token to ${path}: ${String(e)}`);
  }
}

/** mtime of the token file after the last write WE made — an external
 *  write (a pasted token via POST /api/tvmd) bumps it past this value
 *  and the collector exits cleanly so its restart loop picks up the
 *  new session. */
let tokenFileMtime = 0;

function loadConfig(): Config | null {
  const env = process.env.TVMD_ENV === "demo" ? "demo" : "live";
  const defaults = DEFAULT_HOSTS[env];
  // default lives under ./data so it lands on the container's /app/data
  // volume (VPS: survives redeploys; Mac: gitignored web/data/)
  const tokenFile = process.env.TVMD_TOKEN_FILE ?? "./data/.tradovate-md-token.json";
  const envToken = (process.env.TVMD_TOKEN ?? "").trim();
  // persisted token (fresher — renewed every 20 min) beats the env token;
  // TVMD_TOKEN is only the bootstrap on a fresh volume
  const token = readTokenFile(tokenFile) || envToken;

  // no DOM: L2 is unused, so the book is never subscribed
  const subsRaw = (process.env.TVMD_SUBS ?? "quote,hist,chart").toLowerCase();
  const subs = { quote: false, hist: false, chart: false };
  for (const part of subsRaw.split(",")) {
    const s = part.trim();
    if (s === "quote" || s === "hist" || s === "chart") subs[s] = true;
    else if (s) logErr(`unknown TVMD_SUBS entry '${s}' (quote|hist|chart)`);
  }

  return {
    env,
    mdHost: process.env.TVMD_MD_HOST ?? defaults.md,
    tradeHost: process.env.TVMD_TRADE_HOST ?? defaults.trade,
    restHost:
      process.env.TVMD_REST_HOST ??
      (env === "demo" ? "https://demo.tradovateapi.com/v1" : "https://live.tradovateapi.com/v1"),
    token,
    tokenFile,
    symbols: (process.env.TVMD_SYMBOLS ?? "NQM7,ESM7")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    subs,
    chartElements: Number(process.env.TVMD_CHART_ELEMENTS ?? 10) || 10,
    outDir: process.env.TVMD_OUT ?? "./data/tradovate-md",
    quiet: process.env.TVMD_QUIET === "1",
    debug: process.env.TVMD_DEBUG === "1",
    summaryMs: Number(process.env.TVMD_SUMMARY_MS ?? 10000) || 0,
    transport: process.env.TVMD_TRANSPORT === "http" ? "http" : "ws",
    sinkPort: Number(process.env.TVMD_SINK_PORT ?? 3777) || 3777,
  };
}

const USAGE = `Tradovate market-data collector — replays the app's md WebSocket session.
Capture an access token first (docs/TRADOVATE-CAPTURE-GUIDE.md), then:

  cd web
  node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts

env:
  TVMD_TOKEN          captured access token (required unless TVMD_TOKEN_FILE is warm)
  TVMD_ENV            live|demo                        (default live)
  TVMD_MD_HOST        md WS URL override               (default wss://md.tradovateapi.com/v1/websocket)
  TVMD_TRADE_HOST     trading WS URL override          (default wss://live.tradovateapi.com/v1/websocket)
  TVMD_SYMBOLS        comma-separated contract symbols (default NQM7,ESM7)
  TVMD_SUBS           quote,hist,chart                 (default all)
  TVMD_CHART_ELEMENTS  tick-history elements           (default 10)
  TVMD_OUT            JSONL output dir                 (default ./data/tradovate-md)
  TVMD_TOKEN_FILE     token persistence file           (default ./data/.tradovate-md-token.json)
  TVMD_SUMMARY_MS     console summary cadence, 0=off   (default 10000)
  TVMD_QUIET          1 = errors only
  TVMD_DEBUG          1 = echo raw frames to console
  TVMD_TRANSPORT      ws = direct socket (default); http = browser-relay sink
  TVMD_SINK_PORT      sink listen port                 (default 3777)
  TVMD_REST_HOST      REST fallback base URL           (default demo/live tradovateapi.com/v1)`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

loadDotEnv();
const cfg = loadConfig();
if (!cfg) {
  console.error("tradovateMd: config failed");
  process.exit(1);
}
if (cfg.transport === "ws" && !cfg.token) {
  console.error("tradovateMd: no token — capture one (docs/TRADOVATE-CAPTURE-GUIDE.md) and set TVMD_TOKEN");
  process.exit(1);
}
if (cfg.symbols.length === 0) {
  console.error("tradovateMd: TVMD_SYMBOLS is empty");
  process.exit(1);
}

/* ----------------------------- logging ----------------------------- */

function ts(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function log(msg: string): void {
  if (!cfg!.quiet) console.log(`[tradovateMd ${ts()} ET] ${msg}`);
}
function logWarn(msg: string): void {
  console.warn(`[tradovateMd ${ts()} ET] warn: ${msg}`);
}
function logErr(msg: string): void {
  console.error(`[tradovateMd ${ts()} ET] ERROR: ${msg}`);
}
function logDebug(msg: string): void {
  if (cfg!.debug) console.log(`[tradovateMd ${ts()} ET] debug: ${msg}`);
}

/** ET-calendar day for the JSONL filename, matching the platform's
 *  session framing. */
function dayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function journalLine(entry: Record<string, unknown>): void {
  try {
    const dir = cfg!.outDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/md-${dayKey()}.jsonl`, JSON.stringify(entry) + "\n");
  } catch (e) {
    logErr(`journal write failed: ${String(e)}`);
  }
}

/* ---------------------- browser-relay sink mode --------------------- */
/* The server rejects non-browser connections for SSO tokens, so the
 * actual WebSocket is opened by the logged-in web platform page
 * (scripts/tradovateMdPage.js, injected via the snippet from
 * scripts/tradovateMdSnippet.ts). The page relays every frame to this
 * sink, which is the single writer for JSONL, stats, and token
 * persistence. CORS + Private Network Access headers let the
 * trader.tradovate.com page POST to 127.0.0.1. */

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
  });
  res.end(JSON.stringify(obj));
}

function startSink(): void {
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, frames: state.framesLogged });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: "bad json" });
        return;
      }
      if (req.url === "/frame") {
        const dir = payload.dir === "out" ? "out" : "in";
        const frame = String(payload.frame ?? "");
        if (dir === "out") {
          if (frame) {
            journalLine({ dir: "out", t: new Date().toISOString(), frame });
            state.framesLogged++;
          }
        } else {
          const parsed = parseFrame(frame);
          if (parsed.type === "a") {
            for (const item of parsed.data) {
              journalLine({ dir: "in", t: new Date().toISOString(), type: parsed.type, data: item });
              state.framesLogged++;
              bumpStats(item);
            }
          } else if (parsed.type === "c") {
            journalLine({ dir: "in", t: new Date().toISOString(), type: parsed.type, data: parsed.data });
          }
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.url === "/status") {
        const msg = String(payload.msg ?? "");
        const level = String(payload.level ?? "info");
        if (level === "error") logErr(`[page] ${msg}`);
        else if (level === "warn") logWarn(`[page] ${msg}`);
        else log(`[page] ${msg}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.url === "/token") {
        const tok = String(payload.token ?? "");
        if (tok) {
          state.token = tok;
          writeTokenFile(cfg!.tokenFile, tok);
          log("token updated from page and persisted");
        }
        sendJson(res, 200, { ok: !!tok });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    });
  });
  server.listen(cfg!.sinkPort, "127.0.0.1", () => {
    log(
      `sink listening on http://127.0.0.1:${cfg!.sinkPort} — run scripts/tradovateMdSnippet.ts and paste the snippet into the logged-in platform page`,
    );
  });
}

/* --------------------------- live session -------------------------- */

interface PendingEntry {
  resolve: (item: TvItem) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const state = {
  sock: null as WebSocket | null,
  reqId: 0,
  pending: new Map<number, PendingEntry>(),
  authorized: false,
  backoffMs: 5_000,
  authBackoffMs: 60_000, // pre-auth kills: slow ladder — see scheduleReconnect
  lastFrameAt: 0,
  shuttingDown: false,
  giveUp: false,
  authFails: 0,
  token: cfg.token,
  framesLogged: 0,
  restActive: false,
  restTick: 0,
};

const MAX_BACKOFF_MS = 60_000;
// Demo SSO JWTs renew via auth/renewaccesstoken, which grants ~30-min
// extensions — renew every 20 min to stay ahead of expiry.
const RENEW_EVERY_MS = 20 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sendRaw(str: string): void {
  const sock = state.sock;
  if (!sock || sock.readyState !== WebSocket.OPEN) return;
  try {
    sock.send(str);
    journalLine({ dir: "out", t: new Date().toISOString(), frame: str });
  } catch (e) {
    logWarn(`send failed: ${String(e)}`);
  }
}

function request(endpoint: string, body: unknown, timeoutMs = 20_000): Promise<TvItem> {
  return new Promise((resolve, reject) => {
    if (!state.sock || state.sock.readyState !== WebSocket.OPEN) {
      reject(new Error("socket not open"));
      return;
    }
    const id = ++state.reqId;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`timeout waiting for '${endpoint}' response (${timeoutMs} ms)`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    sendRaw(encodeRequest(endpoint, id, body));
  });
}

/** SSO JWTs must be sent RAW (unquoted) — the platform's own authorize
 *  frames carry the bare token string, and the server answers the
 *  JSON-quoted form with 401 "Access is denied". Classic API-program
 *  tokens go through request() as usual. */
function requestRaw(endpoint: string, rawBody: string, timeoutMs = 20_000): Promise<TvItem> {
  return new Promise((resolve, reject) => {
    if (!state.sock || state.sock.readyState !== WebSocket.OPEN) {
      reject(new Error("socket not open"));
      return;
    }
    const id = ++state.reqId;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`timeout waiting for '${endpoint}' response (${timeoutMs} ms)`));
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timer });
    sendRaw(`${endpoint}\n${id}\n\n${rawBody}`);
  });
}

/** md push payloads arrive as {e:'md', d:{quotes|histograms|charts}} */
function kindOf(item: TvItem): string {
  const d = item.d as Record<string, unknown> | undefined;
  if (!d) return item.e ?? "?";
  if (d.quotes) return "quote";
  if (d.histograms) return "hist";
  if (d.charts) return "chart";
  return item.e ?? "?";
}

/* console summaries: kind#contractId → {count, last} */
const stats = new Map<string, { count: number; last: unknown }>();
function bumpStats(item: TvItem): void {
  if (item.e !== "md" || !item.d) return;
  const d = item.d as Record<string, unknown>;
  const kind = kindOf(item);
  const list = (d.quotes ?? d.histograms ?? d.charts) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list) || list.length === 0) return;
  const cid = String(list[0].contractId ?? "?");
  const key = `${kind}#${cid}`;
  const row = stats.get(key) ?? { count: 0, last: null };
  row.count += 1;
  row.last = list[0];
  stats.set(key, row);
}

function handleDataFrame(frame: TvFrame): void {
  for (const item of frame.data) {
    // request correlation
    if (item.i && state.pending.has(item.i)) {
      const entry = state.pending.get(item.i)!;
      state.pending.delete(item.i);
      clearTimeout(entry.timer);
      entry.resolve(item);
      continue;
    }
    // unsolicited push / event
    journalLine({ dir: "in", t: new Date().toISOString(), type: frame.type, data: item });
    state.framesLogged++;
    bumpStats(item);
    logDebug(`in ${frame.type} ${JSON.stringify(item).slice(0, 300)}`);
  }
}

async function subscribeOne(endpoint: string, body: Record<string, unknown>, label: string): Promise<void> {
  for (;;) {
    let item: TvItem;
    try {
      item = await request(endpoint, body);
    } catch (e) {
      logWarn(`${label}: ${String(e)}`);
      return;
    }
    if (isSuccess(item)) {
      log(`${label} ok: ${JSON.stringify(item.d)}`);
      return;
    }
    const pen = penaltyOf(item.d);
    if (pen) {
      if (pen.captcha) {
        logErr(`${label}: captcha penalty — cannot retry programmatically; stop and re-capture later`);
        return;
      }
      logWarn(`${label}: penalty, waiting ${pen.time}s then retrying with p-ticket`);
      await sleep(pen.time * 1000);
      body = { ...body, "p-ticket": pen.ticket };
      continue;
    }
    logErr(`${label} failed: ${errorTextOf(item)}`);
    return;
  }
}

async function subscribeAll(): Promise<void> {
  for (const symbol of cfg!.symbols) {
    if (cfg!.subs.quote) await subscribeOne("md/subscribequote", { symbol }, `quote ${symbol}`);
    if (cfg!.subs.hist) await subscribeOne("md/subscribehistogram", { symbol }, `histogram ${symbol}`);
    if (cfg!.subs.chart)
      await subscribeOne("md/getchart", tickChartBody(symbol, cfg!.chartElements), `tick chart ${symbol}`);
  }
}

/* --------------- REST polling fallback (md-device quota) --------------- */
/* When the md WebSocket authorizes keep getting killed (device-quota
 * exhaustion after reconnect churn), the same market-data engine is
 * reachable over REST on the trading host — no md-device pool involved.
 * The fallback polls snapshots every few seconds, journals them in the
 * same JSONL shape the reader expects, and keeps retrying the
 * WebSocket on the slow ladder in the background. */

/** Repeated identical REST failures flood the container log (a dead
 *  token errors every poll). Log each distinct error at most once per
 *  5 minutes. */
const restErrLog: Record<string, { at: number }> = {};
function throttledRestErr(msg: string): void {
  const now = Date.now();
  const last = restErrLog[msg];
  if (last && now - last.at < 5 * 60_000) return;
  restErrLog[msg] = { at: now };
  if (Object.keys(restErrLog).length > 50) {
    for (const k of Object.keys(restErrLog)) {
      if (now - restErrLog[k].at > 10 * 60_000) delete restErrLog[k];
    }
  }
  logErr(msg);
}

async function restFetch(path: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(`${cfg!.restHost}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = (await res.text().catch(() => "")).slice(0, 140);
      if (res.status === 401) throttledRestErr(`REST ${path} rejected (token?): ${txt}`);
      else throttledRestErr(`REST ${path} ${res.status}: ${txt}`);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (e) {
    throttledRestErr(`REST ${path} failed: ${String(e)}`);
    return null;
  }
}

function journalChartPacket(p: unknown): void {
  journalLine({ dir: "in", t: new Date().toISOString(), type: "a", data: { e: "chart", d: { charts: [p] } } });
  state.framesLogged++;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function journalRestResponse(kind: "chart" | "quote" | "hist", json: unknown): void {
  const j = (json ?? {}) as Record<string, unknown>;
  const d = j.d as Record<string, unknown> | undefined;
  if (kind === "chart") {
    const packets = asArray(j.charts ?? d?.charts);
    for (const p of packets) journalChartPacket(p);
    return;
  }
  const keys = kind === "quote" ? ["quotes"] : ["histograms"];
  const list = asArray(j[keys[0]] ?? d?.[keys[0]]);
  if (list.length) {
    for (const item of list) {
      journalLine({ dir: "in", t: new Date().toISOString(), type: "a", data: { e: "md", d: { [keys[0]]: [item] } } });
      state.framesLogged++;
    }
    return;
  }
  // some endpoints may return a bare object (quote with `entries`,
  // histogram with `items`)
  if (kind === "quote" && j.entries) {
    journalLine({ dir: "in", t: new Date().toISOString(), type: "a", data: { e: "md", d: { quotes: [j] } } });
    state.framesLogged++;
  } else if (kind === "hist" && j.items) {
    journalLine({ dir: "in", t: new Date().toISOString(), type: "a", data: { e: "md", d: { histograms: [j] } } });
    state.framesLogged++;
  }
}

const CHART_BODY = {
  chartDescription: {
    underlyingType: "Tick",
    elementSize: 1,
    elementSizeUnit: "UnderlyingUnits",
    withHistogram: false,
  },
  timeRange: { asMuchAsElements: 10 },
};

async function restPoll(): Promise<void> {
  state.restTick++;
  for (const sym of cfg!.symbols) {
    const chart = await restFetch("/md/getchart", { symbol: sym, ...CHART_BODY });
    if (chart !== null) journalRestResponse("chart", chart);
    if (state.restTick % 3 === 0) {
      if (cfg!.subs.quote) {
        const q = await restFetch("/md/getquote", { symbol: sym });
        if (q !== null) journalRestResponse("quote", q);
      }
      if (cfg!.subs.hist) {
        const h = await restFetch("/md/gethistogram", { symbol: sym });
        if (h !== null) journalRestResponse("hist", h);
      }
    }
  }
}

function startRestFallback(): void {
  if (state.restActive) return;
  state.restActive = true;
  log("md authorizes keep getting killed — switching to REST polling fallback (WS retried on the slow ladder)");
  void restPoll();
  restTimer = setInterval(() => void restPoll(), 2_000);
  // deliberately NOT unref'd: in REST-only mode this interval is what
  // keeps the process alive
  const summary = setInterval(() => {
    if (state.restActive) log(`REST fallback active — ${state.framesLogged} frames journaled`);
  }, 60_000);
  if (typeof summary.unref === "function") summary.unref();
}

let restTimer: ReturnType<typeof setInterval> | null = null;

function stopRestFallback(): void {
  if (!state.restActive) return;
  state.restActive = false;
  if (restTimer) {
    clearInterval(restTimer);
    restTimer = null;
  }
  log("md WebSocket restored — leaving REST fallback");
}

async function authorize(): Promise<void> {
  if (!state.sock) return;
  let item: TvItem;
  try {
    item = await requestRaw("authorize", state.token, 25_000);
  } catch (e) {
    logWarn(`authorize: ${String(e)}`);
    item = { s: 0, d: { errorText: String(e) } };
  }
  if (isSuccess(item)) {
    state.authorized = true;
    state.authFails = 0;
    state.backoffMs = 5_000;
    state.authBackoffMs = 60_000;
    stopRestFallback();
    log("authorized ok");
    await subscribeAll();
    return;
  }
  const msg = errorTextOf(item);
  logErr(`authorize failed: ${msg}`);
  if (/token|expir|auth|invalid/i.test(msg)) {
    logErr("token rejected — re-capture (docs/TRADOVATE-CAPTURE-GUIDE.md) and set TVMD_TOKEN");
  }
  const pen = penaltyOf(item.d);
  if (!pen) {
    // hard denial (not a rate-limit penalty): don't reconnect forever —
    // reconnect storms earn p-tickets (research doc §5)
    state.authFails += 1;
    if (state.authFails >= 3) {
      state.authFails = 0;
      state.authBackoffMs = 600_000;
      startRestFallback();
      scheduleReconnect(false); // keep probing the WebSocket every ~10 min
      return;
    }
  }
  const wait = pen ? pen.time * 1000 : 60_000;
  if (pen) logWarn(`authorize penalty — retrying in ${pen.time}s`);
  const timer = setTimeout(() => {
    if (!state.shuttingDown && !state.giveUp && state.sock) void authorize();
  }, wait);
  if (typeof timer.unref === "function") timer.unref();
}

/* Token renewal: auth/renewaccesstoken lives on the TRADING socket
 * (the md socket 404s it) and returns d.accessToken. */
async function renewToken(): Promise<void> {
  const old = state.token;
  const next = await renewViaTradeSocket(old);
  if (next) {
    state.token = next;
    writeTokenFile(cfg!.tokenFile, next);
    log(`token renewed (${old.slice(0, 8)}… → ${next.slice(0, 8)}…) and saved to ${cfg!.tokenFile}`);
  } else {
    logWarn("token renewal failed — retrying next cycle; if the session drops, re-capture a token");
  }
}

function renewViaTradeSocket(oldToken: string): Promise<string | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(cfg!.tradeHost);
    } catch {
      resolve(null);
      return;
    }
    let id = 0;
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 20_000);
    if (typeof timer.unref === "function") timer.unref();
    ws.onmessage = (ev) => {
      const frame = parseFrame(ev.data);
      if (frame.type === "o") {
        ws.send(`authorize\n${++id}\n\n${oldToken}`); // SSO JWT: raw, unquoted
      } else if (frame.type === "h") {
        ws.send("[]");
      } else if (frame.type === "a") {
        for (const item of frame.data) {
          if (item.i === 1 && !isSuccess(item)) {
            clearTimeout(timer);
            finish(null);
            return;
          }
          if (item.i === 1 && isSuccess(item)) {
            ws.send(`auth/renewaccesstoken\n${++id}\n\n${JSON.stringify({ token: oldToken })}`);
          } else if (item.i === 2) {
            clearTimeout(timer);
            const d = item.d as Record<string, unknown> | undefined;
            const next =
              typeof d?.accessToken === "string"
                ? d.accessToken
                : typeof d?.token === "string"
                  ? d.token
                  : typeof item.d === "string"
                    ? item.d
                    : null;
            finish(isSuccess(item) && next ? next : null);
            return;
          }
        }
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      finish(null);
    };
  });
}

/* --------------------------- connection ---------------------------- */

function scheduleReconnect(wasAuthorized: boolean): void {
  if (state.shuttingDown || state.giveUp) return;
  // Two different worlds:
  //  - the connection had been AUTHORIZED and the server recycled it
  //    (routine on demo, ~40-60s cadence): reconnect fast (5s ladder).
  //  - it died BEFORE authorize (quota kill, maintenance): hammering
  //    only burns more device registrations — wait 60s, doubling to
  //    10 min, and let the quota window roll.
  const wait = wasAuthorized ? state.backoffMs : state.authBackoffMs;
  if (wasAuthorized) state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs * 2);
  else state.authBackoffMs = Math.min(600_000, state.authBackoffMs * 2);
  logWarn(`reconnecting in ${Math.round(wait / 1000)}s${wasAuthorized ? "" : " (pre-auth kill — slow ladder)"}`);
  // deliberately NOT unref'd: after the socket closes this timer is the
  // only thing keeping the process alive until the next connect
  setTimeout(() => connect(), wait);
}

function connect(): void {
  if (state.shuttingDown || state.giveUp) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(cfg!.mdHost);
  } catch (e) {
    logWarn(`connect failed: ${String(e)}`);
    scheduleReconnect(false); // never got far enough to authorize
    return;
  }
  state.sock = ws;
  state.authorized = false;
  log(`connecting ${cfg!.mdHost}`);

  ws.onopen = () => {
    log("socket open — waiting for 'o' frame to authorize");
    state.lastFrameAt = Date.now();
  };

  ws.onmessage = (ev) => {
    state.lastFrameAt = Date.now();
    const frame = parseFrame(ev.data);
    if (frame.type === "o") {
      logDebug("in o");
      void authorize();
      return;
    }
    if (frame.type === "h") {
      sendRaw("[]");
      lastHeartbeatSentAt = Date.now();
      return;
    }
    if (frame.type === "c") {
      logWarn(`server sent close frame${frame.data.length ? `: ${JSON.stringify(frame.data)}` : ""}`);
      return;
    }
    if (frame.type === "a") {
      handleDataFrame(frame);
      return;
    }
    logDebug(`in unknown frame type '${frame.type}'`);
  };

  ws.onclose = () => {
    state.sock = null;
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("socket closed"));
    }
    state.pending.clear();
    const wasAuthorized = state.authorized;
    state.authorized = false;
    if (!state.shuttingDown) scheduleReconnect(wasAuthorized);
  };

  ws.onerror = () => {
    /* onclose follows */
  };
}

/* ------------------------------ main ------------------------------- */

log(
  `boot: transport=${cfg.transport} env=${cfg.env} symbols=${cfg.symbols.join(",")} subs=${Object.keys(cfg.subs).filter((k) => cfg.subs[k as keyof typeof cfg.subs]).join(",")} out=${cfg.outDir}`,
);

try {
  mkdirSync(cfg.outDir, { recursive: true });
} catch (e) {
  logErr(`cannot create output dir ${cfg.outDir}: ${String(e)}`);
  process.exit(1);
}

if (cfg.transport === "http") {
  // Browser relay: the logged-in page holds the token and the socket;
  // this process only sinks frames + stats + renewed tokens.
  startSink();
  log("token is supplied and renewed by the browser page; renewals persist to the token file");
} else {
  log("SSO token auto-renews every 20 min via auth/renewaccesstoken (demo grants ~30-min extensions); renewals persist to the token file");
  if (cfg.token) writeTokenFile(cfg.tokenFile, cfg.token); // keep the file warm for restarts
  connect();
}

// Client heartbeats run on OUR send clock, not inbound silence: during
// RTH the server pushes frames continuously, so an inbound-idle rule
// never fires and the server drops the socket ~30s after connect.
let lastHeartbeatSentAt = 0;
const heartbeatTimer = setInterval(() => {
  if (state.sock && state.sock.readyState === WebSocket.OPEN && shouldSendHeartbeat(Date.now(), lastHeartbeatSentAt)) {
    sendRaw("[]");
    lastHeartbeatSentAt = Date.now();
  }
}, 500);
if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

const renewTimer = setInterval(() => {
  if (cfg.transport === "ws" && !state.shuttingDown) void renewToken();
}, RENEW_EVERY_MS);
if (typeof renewTimer.unref === "function") renewTimer.unref();

// hot-swap watch: an external write to the token file (a token pasted
// in the frontend) restarts the collector so it boots with the new
// session. Own writes (boot bootstrap + renewals) update the baseline.
try {
  tokenFileMtime = existsSync(cfg.tokenFile) ? statSync(cfg.tokenFile).mtimeMs : 0;
} catch {
  tokenFileMtime = 0;
}
const tokenWatch = setInterval(() => {
  if (state.shuttingDown) return;
  try {
    if (!existsSync(cfg.tokenFile)) return;
    const m = statSync(cfg.tokenFile).mtimeMs;
    if (tokenFileMtime !== 0 && m > tokenFileMtime + 500) {
      log("token file changed externally (new session pasted) — restarting to pick it up");
      process.exit(0); // the container entrypoint loop restarts us immediately
    }
  } catch {
    /* ignore */
  }
}, 10_000);
if (typeof tokenWatch.unref === "function") tokenWatch.unref();

if (cfg.summaryMs > 0) {
  const summaryTimer = setInterval(() => {
    if (stats.size === 0) return;
    const lines = [...stats.entries()]
      .map(([key, row]) => {
        const j = JSON.stringify(row.last).slice(0, 220);
        return `${key}: ${row.count} msgs, last ${j}`;
      })
      .join("\n  ");
    log(`last ${cfg.summaryMs / 1000}s\n  ${lines}`);
    stats.clear();
  }, cfg.summaryMs);
  if (typeof summaryTimer.unref === "function") summaryTimer.unref();
}

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log(`received ${signal} — closing. ${state.framesLogged} push frames logged to ${cfg!.outDir}`);
  clearInterval(heartbeatTimer);
  clearInterval(renewTimer);
  if (restTimer) clearInterval(restTimer);
  if (state.sock) {
    try {
      state.sock.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
