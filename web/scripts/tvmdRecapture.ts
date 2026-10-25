/* ------------------------------------------------------------------ *
 * tvmdRecapture — VPS-side automatic Tradovate session autoheal.
 *
 * The Google-SSO account has no password to re-authenticate with, so
 * the heal path is: a persistent Chromium profile whose Google session
 * is captured ONCE (either the one-time remote-debugging login below,
 * or — preferred, far more durable — cookies imported from the user's
 * real Mac Chrome via scripts/tvmdCookieExport.ts, because sessions
 * minted from a datacenter IP in headless chromium get re-verification
 * challenges and die fast). After that the loop self-heals forever:
 *
 *   1. PROACTIVE: every run checks the token file's anchoredAt — the
 *      last FRESH Google-SSO login. Demo SSO sessions hit a hard
 *      lifetime cap (~24h) that renewaccesstoken cannot extend past,
 *      so once anchoredAt is older than TVMD_RECAP_ANCHOR_HOURS
 *      (default 12h) the loop re-anchors even when the token still
 *      answers. The same visit exercises the Google cookies, keeping
 *      the captured session alive.
 *   2. REACTIVE: a dead token (REST probe) triggers the same harvest.
 *   3. The harvest launches headless Chromium with the persistent
 *      profile, imports the captured Google cookies when present,
 *      opens trader.tradovate.com, clicks "Sign in with Google" with
 *      REAL input events when the login screen appears (the stored
 *      Google session then completes silently), captures the
 *      authorize-frame JWT, and writes it to TVMD_TOKEN_FILE — the
 *      collector hot-swaps within ~10s.
 *   4. Failures escalate a backoff ladder (the 60s entrypoint tick
 *      keeps probing the token; only the browser launch backs off —
 *      hammering Google with repeated datacenter logins is what gets
 *      sessions killed), persist a status file the dashboard reads,
 *      and page the operator on Telegram when the Google session
 *      itself is dead (the one thing automation cannot heal).
 *
 * PASSWORD MODE: with TVMD_USERNAME + TVMD_PASSWORD set, step 3 types
 * the credentials into the platform login form instead of the Google
 * click-through — no captured Google session needed at all.
 *
 * Runs every 60s from docker-entrypoint.sh (self-skipping, so it is
 * idle 99% of the time).
 *
 * ONE-TIME LOGIN (fallback when cookie import isn't used):
 *   1. On the VPS run:  TVMD_RECAP_LOGIN=1 node /app/tvmd/scripts/tvmdRecapture.js
 *   2. From the Mac:    ssh -L 9222:127.0.0.1:9222 root@<vps>
 *   3. Open http://127.0.0.1:9222 in Chrome, click the trader.tradovate
 *      page target, complete the Google sign-in in that window.
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { anchoredAtOf, emptyStatus, nextBackoffSeconds, shouldReanchor, type RecapStatus } from "../lib/tvmdRecap";

const TOKEN_FILE = process.env.TVMD_TOKEN_FILE ?? "./data/.tradovate-md-token.json";
const PROFILE = process.env.TVMD_RECAP_PROFILE ?? "./data/tvmd-browser-profile";
const PLATFORM = process.env.TVMD_PLATFORM_URL ?? "https://trader.tradovate.com";
/** the captured Google SSO cookies (Mac export) — injected into the
 *  profile at harvest time so the click-through completes silently */
const GOOGLE_SESSION_FILE = process.env.TVMD_GOOGLE_SESSION_FILE ?? path.join(path.dirname(PROFILE), "tvmd-google-session.json");
const STATUS_FILE = process.env.TVMD_RECAP_STATUS ?? path.join(path.dirname(TOKEN_FILE), ".recap-status.json");
const ANCHOR_HOURS = Number(process.env.TVMD_RECAP_ANCHOR_HOURS ?? 12) || 12;
/** login mode via env flag OR a request marker written by the dashboard
 *  button (/api/tvmd/login) — the entrypoint loop picks the marker up
 *  within a minute */
const LOGIN_REQUEST = `${PROFILE}/.login-request`;
const LOGIN_MODE = process.env.TVMD_RECAP_LOGIN === "1" || existsSync(LOGIN_REQUEST);
const LOGIN_LOCK = `${PROFILE}/.login-running`;
/** serializes harvest runs (entrypoint loop is sequential, but a manual
 *  invocation must not overlap a login-mode browser) */
const RUN_LOCK = `${PROFILE}/.recap-running`;
const BACKOFF_FILE = `${PROFILE}/.recap-backoff`;

const HOOK = `(() => {
  try {
    const Orig = window.WebSocket;
    const origSend = Orig.prototype.send;
    Orig.prototype.send = function (data) {
      const s = String(data);
      if (s.startsWith("authorize")) {
        const m = s.match(/\\n\\n(.+)$/s);
        if (m) window.__tvmdTok = m[1].trim().replace(/^"|"$/g, "");
      }
      return origSend.apply(this, arguments);
    };
    window.WebSocket = function (...a) {
      const ws = new Orig(...a);
      ws.addEventListener("message", (ev) => {
        const s = String(ev.data);
        const m = s.match(/"accessToken":"([^"]+)"/);
        if (m) window.__tvmdTok = m[1];
      });
      return ws;
    };
    window.WebSocket.prototype = Orig.prototype;
    Object.setPrototypeOf(window.WebSocket, Orig);
    window.__tvmdTok = null;
  } catch (e) {}
})();`;

function log(msg: string): void {
  console.log(`[tvmdRecapture ${new Date().toISOString()}] ${msg}`);
}

/* ---- config: REST probe must match the collector's environment ---- */
const ENV = process.env.TVMD_ENV === "demo" ? "demo" : "live";
const REST_HOST = process.env.TVMD_REST_HOST ?? (ENV === "demo" ? "https://demo.tradovateapi.com/v1" : "https://live.tradovateapi.com/v1");
const SYMBOL = (process.env.TVMD_SYMBOLS ?? "MNQZ6").split(",")[0].trim();

/** Age alone can't tell a fresh-but-dead token (sessions die minutes
 *  after their last renewal once the hard cap hits). Probe the REST
 *  engine — the same gate the collector uses — and recapture whenever
 *  the token doesn't answer. */
async function tokenAlive(): Promise<boolean> {
  try {
    const raw = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { token?: string };
    if (typeof raw.token !== "string" || !raw.token) return false;
    const res = await fetch(`${REST_HOST}/md/getquote`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${raw.token}` },
      body: JSON.stringify({ symbol: SYMBOL }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------------- durable state (volume) ---------------------- */

function readStatus(): RecapStatus {
  try {
    const raw = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as Partial<RecapStatus>;
    return { ...emptyStatus(), ...raw };
  } catch {
    return emptyStatus();
  }
}

function writeStatus(next: Partial<RecapStatus>): void {
  const merged: RecapStatus = { ...readStatus(), ...next };
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(merged, null, 2));
  } catch (e) {
    log(`warn: cannot write status file: ${String(e)}`);
  }
}

function clearBackoff(): void {
  try {
    unlinkSync(BACKOFF_FILE);
  } catch {
    /* absent */
  }
}

function setBackoff(failures: number): void {
  const secs = nextBackoffSeconds(failures);
  try {
    writeFileSync(BACKOFF_FILE, JSON.stringify({ until: Date.now() + secs * 1000, failures }));
  } catch {
    /* best-effort */
  }
}

function backoffActive(): boolean {
  try {
    const raw = JSON.parse(readFileSync(BACKOFF_FILE, "utf8")) as { until?: unknown };
    return typeof raw.until === "number" && Date.now() < raw.until;
  } catch {
    return false;
  }
}

/* ------------------------- Telegram paging ------------------------- */

async function sendAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log(`telegram alert rejected: ${res.status}`);
  } catch (e) {
    log(`telegram alert failed: ${String(e)}`);
  }
}

/** Alert once per episode: first failure, or again after 3h of
 *  continued failure. Resets on a successful heal. */
async function alertOnFailure(status: RecapStatus, error: string): Promise<void> {
  const last = status.lastAlertAt ? Date.parse(status.lastAlertAt) : 0;
  if (status.googleSessionOk === false && Number.isFinite(last) && Date.now() - last < 3 * 3_600_000) {
    return; // already paged recently
  }
  const mark = new Date().toISOString();
  writeStatus({ lastAlertAt: mark });
  await sendAlert(
    `⚠️ <b>Tradovate md autoheal failed</b>\n${error}\n\n` +
      `The collector is running on a dead token chain until this heals.\n` +
      (PASSWORD_MODE
        ? `Password mode (TVMD_USERNAME): check the credentials, or log in once by hand if Tradovate asked for a code/captcha.`
        : `If the Google session itself expired: open the dashboard → /tvmd → Browser login (one-time Google sign-in), or re-import cookies via scripts/tvmdCookieExport.ts --ship.`),
  );
}

/* --------------------- chromium lifecycle -------------------------- */

/** Container rebuilds leave Singleton* files pointing at the dead
 *  container's hostname — chromium then refuses to start ("profile in
 *  use", exit 21) and the heal loop spins forever. The entrypoint runs
 *  us sequentially and RUN_LOCK guards manual overlap, so clearing is
 *  always safe here. */
function cleanStaleLocks(): void {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      unlinkSync(path.join(PROFILE, f));
    } catch {
      /* absent */
    }
  }
}

async function debugPortOf(proc: ChildProcess): Promise<number> {
  const portFile = `${PROFILE}/DevToolsActivePort`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, "utf8").split("\n")[0].trim();
      const port = Number(line);
      if (Number.isFinite(port) && port > 0) {
        // the file can be stale from a dead run — only trust a port
        // that actually answers
        try {
          const probe = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
          if (probe.ok) return port;
        } catch {
          /* not up — keep waiting */
        }
      }
    }
    if (proc.exitCode !== null) throw new Error(`chromium exited early (code ${proc.exitCode})`);
    await sleep(500);
  }
  throw new Error("chromium never opened its debug port");
}

interface Target {
  type: string;
  webSocketDebuggerUrl?: string;
  url?: string;
}

async function cdp(port: number): Promise<{ ws: WebSocket; call: (m: string, p?: unknown) => Promise<Record<string, unknown>> }> {
  // chromium can take a few seconds after the port file appears — retry
  let target: Target | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
      if (res.ok) {
        target = (await res.json()) as Target;
        break;
      }
    } catch {
      /* keep trying */
    }
    await sleep(1500);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`chromium debug endpoint never answered on port ${port}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  let nextId = 1;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
    const id = m.id as number;
    if (id && pending.has(id)) {
      pending.get(id)!(m);
      pending.delete(id);
    }
  };
  const call = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, call };
}

/* ------------------- captured Google SSO cookie import --------------- */
/* The one-time capture: cookies exported from the user's real Chrome
 * (trusted device, residential IP, 2FA done) are far more durable than
 * a session minted from this datacenter. Inject them before the page
 * load so the SSO click-through completes without any prompt. */

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

async function importGoogleSession(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(GOOGLE_SESSION_FILE, "utf8");
  } catch {
    return 0; // no capture yet — the stored profile session (if any) still applies
  }
  let cookies: SessionCookie[];
  try {
    const parsed = JSON.parse(raw) as { cookies?: unknown };
    cookies = Array.isArray(parsed.cookies) ? (parsed.cookies as SessionCookie[]) : [];
  } catch {
    return 0;
  }
  // drop partitioned cookies — Network.setCookies rejects them
  const clean = cookies.filter((c) => c.name && c.value && c.domain).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    expires: Number.isFinite(c.expires) ? c.expires : Math.floor(Date.now() / 1000) + 365 * 86400,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite ?? "Lax",
  }));
  if (clean.length === 0) return 0;
  try {
    await call("Network.setCookies", { cookies: clean });
    log(`imported ${clean.length} captured session cookies from ${GOOGLE_SESSION_FILE}`);
    return clean.length;
  } catch (e) {
    log(`warn: cookie import failed: ${String(e)}`);
    return 0;
  }
}

/* ------------------------ SSO click-through ------------------------- */
/* When the profile's platform session is gone the page lands on the
 * welcome/login screen. The Google button is a GIS widget that ignores
 * synthetic clicks, so we drive it with REAL CDP input events at the
 * visible control's rect. If the flow completes in a popup (the button
 * says "opens in new tab"), the popup writes the platform session into
 * this same profile's storage — a reload of our tab then boots logged
 * in and the authorize frame fires. */

async function evalJson(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>, expression: string): Promise<Record<string, unknown> | null> {
  const msg = await call("Runtime.evaluate", { expression, returnByValue: true });
  const res = msg?.result as { result?: { value?: unknown } } | undefined;
  const val = res?.result?.value;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

async function clickSignInWithGoogle(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<boolean> {
  // candidate: deepest element whose own text is the Google SSO label,
  // with a real on-screen box
  const found = await evalJson(
    call,
    `(() => {
      const el = [...document.querySelectorAll("button, a, span, div")]
        .find(e => /^sign in with google/i.test((e.innerText||"").trim()) && (e.tagName === "BUTTON" || e.tagName === "A") )
        || [...document.querySelectorAll("span, div")]
             .find(e => { const t=(e.innerText||"").trim(); return /^sign in with google/i.test(t) && e.children.length === 0; });
      if (!el) return JSON.stringify({ ok: false });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, tag: el.tagName, x: r.x + r.width/2, y: r.y + r.height/2 });
    })()`,
  );
  if (!found?.ok) return false;
  const x = Number(found.x);
  const y = Number(found.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0 || x > 2000 || y > 2000) return false;
  log(`clicking Sign in with Google (${found.tag}) at ${Math.round(x)},${Math.round(y)}`);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return true;
}

/* --------------------- username/password login ---------------------- */
/* A non-SSO login (TVMD_USERNAME + TVMD_PASSWORD) removes Google from
 * the chain entirely: no cookie capture, no datacenter-IP challenges.
 * The platform page itself performs the login request, so its client
 * signing stays whatever the current web build does. Credentials come
 * from env only and are never logged. */

const USERNAME = process.env.TVMD_USERNAME?.trim() || "";
const PASSWORD = process.env.TVMD_PASSWORD || "";
const PASSWORD_MODE = USERNAME !== "" && PASSWORD !== "";

/** focus a field found by `finder` (JS returning an element), clear it,
 *  then type with Input.insertText so React sees real input events */
async function typeInto(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>, finder: string, text: string): Promise<boolean> {
  const ok = await evalJson(
    call,
    `(() => { const el = (${finder})(); if (!el) return JSON.stringify({ ok: false });
      el.focus(); el.select?.(); return JSON.stringify({ ok: true }); })()`,
  );
  if (!ok?.ok) return false;
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await call("Input.insertText", { text });
  return true;
}

const VISIBLE = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }`;
const FIND_PASSWORD = `() => [...document.querySelectorAll('input[type="password"]')].find(${VISIBLE})`;
const FIND_USERNAME = `() => { const pw = (${FIND_PASSWORD})(); if (!pw) return null;
  const inputs = [...document.querySelectorAll('input:not([type]), input[type="text"], input[type="email"]')].filter(${VISIBLE});
  const before = inputs.filter(e => e.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before[before.length - 1] ?? inputs[0] ?? null; }`;

async function hasPasswordForm(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<boolean> {
  const st = await evalJson(call, `JSON.stringify({ ok: !!(${FIND_PASSWORD})() })`);
  return !!st?.ok;
}

async function submitPasswordLogin(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<boolean> {
  if (!(await typeInto(call, FIND_USERNAME, USERNAME))) return false;
  if (!(await typeInto(call, FIND_PASSWORD, PASSWORD))) return false;
  const btn = await evalJson(
    call,
    `(() => { const el = [...document.querySelectorAll('button, input[type="submit"]')]
        .filter(${VISIBLE})
        .find(e => /^(log ?in|sign ?in|login)$/i.test((e.innerText || e.value || "").trim()));
      if (!el) return JSON.stringify({ ok: false });
      const r = el.getBoundingClientRect(); return JSON.stringify({ ok: true, x: r.x + r.width/2, y: r.y + r.height/2 }); })()`,
  );
  if (btn?.ok) {
    const x = Number(btn.x);
    const y = Number(btn.y);
    log(`submitting username/password login for ${USERNAME}`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } else {
    // no labelled button — Enter in the (still focused) password field
    log(`submitting username/password login for ${USERNAME} (Enter)`);
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  return true;
}

/** after a submit: a rejection or a human-only step (MFA code, captcha)
 *  must fail fast — retrying credentials is what earns penalty tickets */
async function passwordLoginBlocker(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<string | null> {
  const st = await evalJson(call, `JSON.stringify({ text: (document.body?.innerText ?? "").slice(0, 2000) })`);
  const text = String(st?.text ?? "");
  if (/incorrect|invalid (user|name|password|credentials)|wrong password|not recognized/i.test(text)) {
    return "username/password rejected by Tradovate — check TVMD_USERNAME / TVMD_PASSWORD";
  }
  if (/captcha|verification code|security code|two-factor|2fa|enter the code/i.test(text)) {
    return "Tradovate asked for a human step (verification code / captcha) — log in once by hand, then the loop resumes";
  }
  return null;
}

async function onLoginScreen(call: (m: string, p?: unknown) => Promise<Record<string, unknown>>): Promise<boolean> {
  const st = await evalJson(call, `JSON.stringify({ path: location.pathname, text: (document.body?.innerText ?? "").slice(0, 400) })`);
  if (!st) return false;
  return /welcome/.test(String(st.path ?? "")) || /sign in with google/i.test(String(st.text ?? ""));
}

async function harvest(port: number, timeoutMs: number): Promise<string> {
  const { ws, call } = await cdp(port);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  try {
    await call("Page.enable");
    if (!PASSWORD_MODE) await importGoogleSession(call);
    await call("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
    await call("Page.navigate", { url: PLATFORM });
    const start = Date.now();
    const deadline = start + timeoutMs;
    let clicked = false;
    let reloaded = false;
    let sawLogin = false;
    let submittedAt = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const msg = await call("Runtime.evaluate", { expression: "window.__tvmdTok ?? null", returnByValue: true });
      const res = msg?.result as { result?: { value?: unknown } } | undefined;
      const val = res?.result?.value ?? null;
      if (typeof val === "string" && /^eyJ[^.]+\.eyJ/.test(val)) {
        close();
        return val;
      }
      if (PASSWORD_MODE) {
        // username/password: fill the platform's own form ONCE; a
        // rejection or MFA/captcha prompt fails fast (no retry storm)
        if (!clicked && (await hasPasswordForm(call))) {
          sawLogin = true;
          clicked = await submitPasswordLogin(call);
          submittedAt = Date.now();
        } else if (clicked && Date.now() > submittedAt + 4000) {
          const blocker = await passwordLoginBlocker(call);
          if (blocker) throw new Error(blocker);
        }
        continue;
      }
      // login screen? click through ONCE, then give the popup time and
      // reload our tab so a popup-completed login is picked up
      if (!clicked && (await onLoginScreen(call))) {
        sawLogin = true;
        clicked = await clickSignInWithGoogle(call);
      }
      // 40s after the click: if the flow completed in a popup, the
      // session now lives in this profile's storage — a reload boots
      // the tab logged in and the authorize frame fires
      if (clicked && !reloaded && Date.now() > start + 40_000) {
        reloaded = true;
        log("SSO click issued — reloading the tab to pick up the completed login");
        await call("Page.reload", {});
      }
    }
    close();
    throw new Error(
      PASSWORD_MODE
        ? sawLogin
          ? "no token captured — the username/password login was submitted but no session started"
          : "no token captured — no username/password form appeared on the platform page"
        : LOGIN_MODE
        ? "no token captured — complete the Google sign-in in the remote-debugging window, then rerun (the profile persists)"
        : sawLogin
          ? "no token captured — the stored Google session did not complete the sign-in; it may be expired (re-import cookies from the Mac or rerun with TVMD_RECAP_LOGIN=1 once)"
          : "no token captured — the platform never reached a login or session state; check the page/network",
    );
  } catch (e) {
    close();
    throw e;
  }
}

/* ------------------------------ main ------------------------------- */

function acquireRunLock(): boolean {
  try {
    // 20-min staleness: a crashed run must not block the loop forever
    if (existsSync(RUN_LOCK)) {
      const started = Number(readFileSync(RUN_LOCK, "utf8"));
      if (Number.isFinite(started) && Date.now() - started < 20 * 60_000) return false;
    }
    writeFileSync(RUN_LOCK, String(Date.now()));
    return true;
  } catch {
    return true; // best-effort: proceed rather than deadlock the heal
  }
}

function releaseRunLock(): void {
  try {
    unlinkSync(RUN_LOCK);
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  if (!acquireRunLock()) {
    log("another recapture run is active — skipping this tick");
    return;
  }
  try {
    if (LOGIN_MODE) {
      try {
        writeFileSync(LOGIN_LOCK, String(Date.now()));
        unlinkSync(LOGIN_REQUEST); // consume the dashboard's request marker
      } catch {
        /* best-effort */
      }
    } else if (backoffActive()) {
      return; // failed recently — the entrypoint tick probes again in 60s
    } else {
      const anchored = anchoredAtOf(TOKEN_FILE);
      if ((await tokenAlive()) && !shouldReanchor(anchored, Date.now(), ANCHOR_HOURS)) {
        return; // healthy chain + fresh anchor — nothing to do
      }
    }

    let token: string;
    try {
      token = await run();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (LOGIN_MODE) {
        // the user just hasn't finished typing — not an autoheal failure
        log(`login-mode harvest not done yet: ${error}`);
        throw e;
      }
      const status = readStatus();
      const next = { ...status, googleSessionOk: false, failures: status.failures + 1, lastAttemptAt: new Date().toISOString(), lastError: error };
      writeStatus(next);
      setBackoff(next.failures);
      await alertOnFailure(next, error);
      throw e;
    }

    const now = new Date().toISOString();
    writeFileSync(TOKEN_FILE, JSON.stringify({ token, renewedAt: now, anchoredAt: now }, null, 2));
    writeStatus({ googleSessionOk: true, failures: 0, lastHealAt: now, lastAttemptAt: now, lastError: null });
    clearBackoff();
    log(`captured ${token.slice(0, 8)}… and wrote ${TOKEN_FILE} — the collector hot-swaps within ~10s`);
  } finally {
    if (LOGIN_MODE) {
      try {
        unlinkSync(LOGIN_LOCK);
      } catch {
        /* ignore */
      }
    }
    releaseRunLock();
  }
}

async function run(): Promise<string> {
  log(LOGIN_MODE ? "login mode: launching chromium with remote debugging on 9222" : "token dead/unverified or anchor stale — launching chromium to re-anchor the session");

  cleanStaleLocks();

  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--no-zygote", // alpine containers: the zygote crashes with broken-pipe and the browser dies
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${PROFILE}`,
  ];
  if (LOGIN_MODE) args.push("--remote-debugging-address=0.0.0.0", "--remote-debugging-port=9222");
  else args.push("--remote-debugging-port=0");

  const proc = spawn(process.env.TVMD_CHROMIUM || "chromium", args, { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  proc.stderr?.on("data", (c: Buffer) => {
    if (chromeErr.length < 4000) chromeErr += c.toString("utf8");
  });

  const dumpChromeErr = () => {
    if (chromeErr.trim()) console.error(`[tvmdRecapture] chromium stderr (first lines):\n${chromeErr.trim().split("\n").slice(0, 12).join("\n")}`);
  };

  let port: number;
  if (LOGIN_MODE) {
    port = 9222;
    log("remote debugging on 0.0.0.0:9222 — from the Mac run:");
    log("  ssh -L 9222:127.0.0.1:9222 root@<vps-ip>");
    log("  then open http://127.0.0.1:9222 in Chrome, click the trader.tradovate.com page, and complete the Google sign-in.");
    // wait for the endpoint like debugPortOf does (fixed port, longer
    // window — first run on a cold profile is slow)
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      try {
        const probe = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(3000) });
        if (probe.ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(2000);
    }
    if (!up) {
      dumpChromeErr();
      const portFile = `${PROFILE}/DevToolsActivePort`;
      console.error(
        `[tvmdRecapture] chromium never answered on 9222 — exitCode=${proc.exitCode}, portFile=${existsSync(portFile) ? readFileSync(portFile, "utf8").trim() : "absent"}`,
      );
      throw new Error("chromium debug endpoint never answered on 9222");
    }
  } else {
    try {
      port = await debugPortOf(proc);
    } catch (e) {
      dumpChromeErr();
      proc.kill("SIGTERM");
      throw e;
    }
  }

  try {
    const token = await harvest(port, LOGIN_MODE ? 20 * 60_000 : 150_000);
    proc.kill("SIGTERM"); // never leave orphan chromium holding the port
    return token;
  } catch (e) {
    proc.kill("SIGTERM"); // never leave orphan chromium holding the port
    dumpChromeErr();
    throw e;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[tvmdRecapture] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
