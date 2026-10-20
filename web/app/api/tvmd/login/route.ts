import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export const dynamic = "force-dynamic";

const LOCK = "/app/data/tvmd-browser-profile/.login-running";
const PUBLIC_URL = process.env.TVMD_LOGIN_PUBLIC ?? "http://31.97.138.30:9222";

/** Start the VPS login browser (tvmdRecapture in login mode). It binds
 *  Chromium's remote-debugging UI on the temporarily published 9222 —
 *  the user completes the Google sign-in there ONCE, the script captures
 *  the token, persists it (collector hot-swaps), and exits. */
export async function POST() {
  if (existsSync(LOCK)) {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs < 20 * 60_000) {
        return Response.json({ ok: false, error: "login browser already running — open the URL and complete the sign-in" });
      }
    } catch {
      /* stale lock — proceed */
    }
  }
  const child = spawn("node", ["/app/tvmd/scripts/tvmdRecapture.js"], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, TVMD_RECAP_LOGIN: "1" },
  });
  child.unref();
  return Response.json({
    ok: true,
    url: PUBLIC_URL,
    hint: "Open the URL in your browser, click the trader.tradovate.com page, and complete the Google sign-in once. The token is captured automatically (20 min window).",
  });
}
