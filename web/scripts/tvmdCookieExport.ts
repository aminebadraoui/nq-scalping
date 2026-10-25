/* ------------------------------------------------------------------ *
 * tvmdCookieExport — the ONE-TIME Google-SSO capture (run on the Mac).
 *
 * Why: the VPS autoheal (scripts/tvmdRecapture.ts) needs a Google
 * session that can complete "Sign in with Google" silently, forever.
 * A session minted from the VPS datacenter IP in headless chromium is
 * fragile — Google re-verifies it and kills it within hours/days. The
 * durable capture is the session already living in YOUR real Chrome:
 * minted on a trusted device + residential IP, 2FA done. Export its
 * cookies once, ship them to the VPS profile, and the autoheal runs
 * indefinitely (the loop's periodic platform visits also keep the
 * cookies warm).
 *
 * Usage:
 *   1. Quit Chrome, relaunch with the debug flag (one time):
 *        open -a "Google Chrome" --args --remote-debugging-port=9333
 *      (keep your normal profile — every window opens with the flag)
 *   2. Make sure you are signed in to Google AND logged into
 *      trader.tradovate.com in that Chrome (if the platform session is
 *      present its cookies ride along and log the VPS browser straight
 *      in without even touching Google).
 *   3. cd web && node --import ../scripts/ts-loader.mjs ./scripts/tvmdCookieExport.ts [--ship]
 *      --ship also copies the file into the running nq-dashboard
 *      container on the VPS (TVMD_SHIP_SSH, default root@31.97.138.30)
 *      where the recapture loop picks it up on its next harvest.
 *
 * The export lands in web/data/tvmd-google-session.json — gitignored,
 * NEVER committed. Treat it like a password: it IS your Google session.
 * ------------------------------------------------------------------ */

import { writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = Number(process.env.TVMD_EXPORT_PORT ?? 9333) || 9333;
const OUT = process.env.TVMD_EXPORT_FILE ?? "./data/tvmd-google-session.json";
const SHIP = process.argv.includes("--ship");
const SHIP_SSH = process.env.TVMD_SHIP_SSH ?? "root@31.97.138.30";
const SHIP_REMOTE_TMP = "/tmp/tvmd-google-session.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: unknown;
  priority?: string;
  sourcePort?: number;
  sourceScheme?: string;
}

async function main(): Promise<void> {
  console.log(`[tvmdCookieExport] connecting to Chrome DevTools on 127.0.0.1:${PORT} …`);
  let version: { webSocketDebuggerUrl?: string } | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        version = (await res.json()) as { webSocketDebuggerUrl?: string };
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (!version?.webSocketDebuggerUrl) {
    console.error(
      `[tvmdCookieExport] Chrome isn't reachable on port ${PORT}.\n` +
        "Quit Chrome, then relaunch it once with the debug flag:\n" +
        '  open -a "Google Chrome" --args --remote-debugging-port=9333\n' +
        "then rerun this script.",
    );
    process.exit(2);
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("DevTools websocket failed"));
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

  const msg = await call("Network.getAllCookies", {});
  const res = msg.result as { cookies?: Cookie[] } | undefined;
  const all = res?.cookies ?? [];
  console.log(`[tvmdCookieExport] browser reported ${all.length} cookies total`);

  // Google SSO + platform sessions. Keep every Google-domain cookie —
  // the full SID/LSID/HSID/__Secure-*PSID family is what makes the
  // OAuth flow complete without a password prompt.
  const wanted = (d: string) =>
    /(^|\.)google\.com$/.test(d) ||
    /(^|\.)gstatic\.com$/.test(d) ||
    /(^|\.)googleapis\.com$/.test(d) ||
    /(^|\.)tradovate\.com$/.test(d);

  const kept = all
    .filter((c) => wanted(c.domain))
    // partitioned cookies are bound to the top-level site — useless (and
    // rejected by setCookies) in another browser
    .filter((c) => !c.partitionKey)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? "/",
      expires: Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 365 * 86400,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite ?? "Lax",
    }));
  if (kept.length === 0) {
    console.error("[tvmdCookieExport] no Google/Tradovate cookies found — sign in to Google in that Chrome first");
    process.exit(3);
  }
  const byDomain: Record<string, number> = {};
  for (const c of kept) byDomain[c.domain] = (byDomain[c.domain] ?? 0) + 1;
  console.log("[tvmdCookieExport] kept cookies by domain:");
  for (const [d, n] of Object.entries(byDomain).sort()) console.log(`  ${d}: ${n}`);

  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), cookies: kept }, null, 2);
  writeFileSync(OUT, payload, { mode: 0o600 });
  chmodSync(OUT, 0o600);
  console.log(`[tvmdCookieExport] wrote ${kept.length} cookies to ${OUT} (mode 600)`);
  ws.close();

  if (SHIP) {
    console.log(`[tvmdCookieExport] shipping to ${SHIP_SSH} …`);
    execSync(`scp -q ${OUT} ${SHIP_SSH}:${SHIP_REMOTE_TMP}`, { stdio: "inherit" });
    const remote = [
      `C=$(docker ps -q | while read c; do`,
      `  if docker inspect "$c" --format '{{.Config.Cmd}}' 2>/dev/null | grep -q docker-entrypoint; then echo "$c"; break; fi;`,
      `done)`,
      `[ -n "$C" ] && docker cp ${SHIP_REMOTE_TMP} "$C":/app/data/tvmd-google-session.json && docker exec "$C" rm -f /app/data/tvmd-browser-profile/.recap-backoff && echo "shipped to container $C" || echo "no nq-dashboard container found"`,
    ].join(" ");
    execSync(`ssh ${SHIP_SSH} '${remote}'`, { stdio: "inherit" });
    console.log(
      "[tvmdCookieExport] done — the recapture loop imports the session on its next harvest. " +
        "The stale-token autoheal (and the proactive 12h re-anchor) now runs unattended.",
    );
  } else {
    console.log("[tvmdCookieExport] rerun with --ship to push the capture to the VPS container.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`[tvmdCookieExport] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
