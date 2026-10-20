/* ------------------------------------------------------------------ *
 * tvmdRecapture — VPS-side automatic Tradovate session-token refresh.
 *
 * Spawns a headless Chromium (bundled in the container image) with a
 * persistent profile on the volume. The profile holds the Google +
 * trader.tradovate.com login (completed ONCE via the remote-debugging
 * login flow below). On each run the script:
 *   1. skips silently when the current token file is fresh (< 4h);
 *   2. otherwise launches Chromium, opens the platform with a
 *      WebSocket hook injected, waits for the auto-login to mint a
 *      session, captures the authorize-frame JWT;
 *   3. writes it to TVMD_TOKEN_FILE (the collector's mtime watcher
 *      hot-swaps the session within ~10s — no redeploy, no HTTP);
 *   4. shuts Chromium down.
 *
 * Runs every 30 min from docker-entrypoint.sh (self-skipping, so it is
 * idle 99% of the time). Env: TVMD_TOKEN_FILE (default ./data/
 * .tradovate-md-token.json), TVMD_RECAP_PROFILE (default ./data/
 * tvmd-browser-profile), TVMD_PLATFORM_URL (default
 * https://trader.tradovate.com).
 *
 * ONE-TIME LOGIN (from the Mac):
 *   1. On the VPS run:  TVMD_RECAP_LOGIN=1 node /app/tvmd/scripts/tvmdRecapture.js
 *   2. From the Mac:    ssh -L 9222:127.0.0.1:9222 root@<vps>
 *   3. Open http://127.0.0.1:9222 in Chrome, click the trader.tradovate
 *      page target, complete the Google sign-in in that window.
 *   4. The script captures the token when login completes, persists it,
 *      and exits. The profile (with the session) lives on the volume.
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const TOKEN_FILE = process.env.TVMD_TOKEN_FILE ?? "./data/.tradovate-md-token.json";
const PROFILE = process.env.TVMD_RECAP_PROFILE ?? "./data/tvmd-browser-profile";
const PLATFORM = process.env.TVMD_PLATFORM_URL ?? "https://trader.tradovate.com";
/** login mode via env flag OR a request marker written by the dashboard
 *  button (/api/tvmd/login) — the entrypoint loop picks the marker up
 *  within a minute */
const LOGIN_REQUEST = `${PROFILE}/.login-request`;
const LOGIN_MODE = process.env.TVMD_RECAP_LOGIN === "1" || existsSync(LOGIN_REQUEST);
const LOGIN_LOCK = `${PROFILE}/.login-running`;

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

const REST_HOST = process.env.TVMD_REST_HOST ?? "https://demo.tradovateapi.com/v1";
const SYMBOL = (process.env.TVMD_SYMBOLS ?? "MNQZ6").split(",")[0].trim();

/** Age alone can't tell a fresh-but-dead token (tonight's died minutes
 *  after renewal). Probe the REST engine — the same gate the collector
 *  uses — and recapture whenever the token doesn't answer. */
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

async function harvest(port: number, timeoutMs: number): Promise<string> {
  const { ws, call } = await cdp(port);
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await call("Page.navigate", { url: PLATFORM });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const msg = await call("Runtime.evaluate", { expression: "window.__tvmdTok ?? null", returnByValue: true });
    const res = msg?.result as { result?: { value?: unknown } } | undefined;
    const val = res?.result?.value ?? null;
    if (typeof val === "string" && /^eyJ[^.]+\.eyJ/.test(val)) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return val;
    }
  }
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  throw new Error(
    LOGIN_MODE
      ? "no token captured — complete the Google sign-in in the remote-debugging window, then rerun (the profile persists)"
      : "no token captured — the stored Google session may have expired; rerun with TVMD_RECAP_LOGIN=1 once",
  );
}

async function main(): Promise<void> {
  if (LOGIN_MODE) {
    try {
      writeFileSync(LOGIN_LOCK, String(Date.now()));
      unlinkSync(LOGIN_REQUEST); // consume the dashboard's request marker
    } catch {
      /* best-effort */
    }
  } else if (await tokenAlive()) {
    log("current token is alive — nothing to do");
    return;
  }
  try {
    await run();
  } finally {
    if (LOGIN_MODE) {
      try {
        unlinkSync(LOGIN_LOCK);
      } catch {
        /* ignore */
      }
    }
  }
}

async function run(): Promise<void> {
  log(LOGIN_MODE ? "login mode: launching chromium with remote debugging on 9222" : "token dead or unverifiable — launching chromium to recapture the session");

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

  const proc = spawn("chromium", args, { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  proc.stderr?.on("data", (c: Buffer) => {
    if (chromeErr.length < 4000) chromeErr += c.toString("utf8");
  });

  let port: number;
  if (LOGIN_MODE) {
    port = 9222;
    await sleep(3000);
    log("remote debugging on 0.0.0.0:9222 — from the Mac run:");
    log("  ssh -L 9222:127.0.0.1:9222 root@<vps-ip>");
    log("  then open http://127.0.0.1:9222 in Chrome, click the trader.tradovate.com page, and complete the Google sign-in.");
  } else {
    port = await debugPortOf(proc);
  }

  let token: string;
  try {
    token = await harvest(port, LOGIN_MODE ? 20 * 60_000 : 120_000);
  } catch (e) {
    proc.kill("SIGTERM"); // never leave orphan chromium holding the port
    if (chromeErr.trim()) {
      console.error(`[tvmdRecapture] chromium stderr (first lines):\n${chromeErr.trim().split("\n").slice(0, 12).join("\n")}`);
    }
    throw e;
  }
  writeFileSync(TOKEN_FILE, JSON.stringify({ token, renewedAt: new Date().toISOString() }, null, 2));
  log(`captured ${token.slice(0, 8)}… and wrote ${TOKEN_FILE} — the collector hot-swaps within ~10s`);
  proc.kill("SIGTERM");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[tvmdRecapture] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
