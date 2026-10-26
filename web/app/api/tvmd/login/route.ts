import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adminUnauthorized, isAdminRequest } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

// request-marker paths (shared with scripts/tvmdRecapture.ts via the
// same env defaults). No spawn here: the entrypoint's 60s recapture
// loop picks the marker up and launches the login browser itself.
const PROFILE = process.env.TVMD_RECAP_PROFILE ?? path.join(process.cwd(), "data", "tvmd-browser-profile");
const LOCK = path.join(PROFILE, ".login-running");
const REQUEST = path.join(PROFILE, ".login-request");
const PUBLIC_URL = process.env.TVMD_LOGIN_PUBLIC ?? "http://31.97.138.30:9222";

/** Ask the VPS login browser to start: writes a request marker on the
 *  volume; the entrypoint loop starts Chromium's remote-debugging UI
 *  (published 9222) within a minute. The user completes the Google
 *  sign-in there ONCE; the script captures the token and exits. */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return adminUnauthorized();
  if (existsSync(LOCK)) {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs < 20 * 60_000) {
        return Response.json({ ok: false, error: "login browser already running — open the URL and complete the sign-in" });
      }
    } catch {
      /* stale lock — proceed */
    }
  }
  try {
    writeFileSync(REQUEST, String(Date.now()));
  } catch (e) {
    return Response.json({ ok: false, error: `cannot write login request: ${String(e)}` });
  }
  if (process.env.TVMD_USERNAME && process.env.TVMD_PASSWORD) {
    // password mode: the marker just means "retry now" — one headless
    // login, no remote-debugging browser to open
    return Response.json({ ok: true, hint: "Password login retry queued — it runs within a minute; watch the autoheal chip." });
  }
  return Response.json({
    ok: true,
    url: PUBLIC_URL,
    hint: "The login browser starts within a minute. Open the URL, click the trader.tradovate.com page, and complete the Google sign-in once — the token is captured automatically.",
  });
}
