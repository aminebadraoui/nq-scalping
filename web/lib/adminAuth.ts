/* ------------------------------------------------------------------ *
 * Shared admin check for the dashboard's write endpoints.
 *
 * The dashboard is public, so every route that mutates state the
 * executor or the operator relies on (strategy overrides, the weekly
 * experiment queue, the Tradovate md token, the login browser, forced
 * Telegram pushes) requires the ADMIN_PASSWORD. The client sends it as
 * `x-admin-password: <pw>` or `Authorization: Bearer <pw>`.
 *
 * FAILS CLOSED: no ADMIN_PASSWORD configured → nothing is authorized.
 * Timing-safe compare; both sides trimmed (a trailing space on the
 * Coolify env var must never lock the owner out).
 *
 * Enforced twice: web/proxy.ts (throttle + fixed delay, the front
 * door) and isAdminRequest() inside each route (defense in depth — a
 * matcher typo must not silently open a route). Pure + unit-tested.
 * ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;
type HeaderBag = { get(name: string): string | null };

const sha = (s: string) => createHash("sha256").update(s).digest();

/** the password presented by the request, or "" */
export function presentedAdminPassword(headers: HeaderBag): string {
  const direct = headers.get("x-admin-password");
  if (direct && direct.trim()) return direct.trim();
  const auth = headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return "";
}

/** timing-safe check of a given password against ADMIN_PASSWORD.
 *  No password configured → false (fail closed). */
export function adminPasswordOk(given: string, env: Env = process.env): boolean {
  const expected = (env.ADMIN_PASSWORD ?? "").trim();
  const g = given.trim();
  if (!expected || !g) return false;
  return timingSafeEqual(sha(g), sha(expected));
}

export function isAdminRequest(req: { headers: HeaderBag }, env: Env = process.env): boolean {
  return adminPasswordOk(presentedAdminPassword(req.headers), env);
}

/** the uniform 401 body — never reveals "wrong" vs "not configured" */
export function adminUnauthorized(headers?: Record<string, string>): Response {
  return Response.json({ ok: false, reason: "admin password required" }, { status: 401, headers });
}

/* ---- protected surface (single source for proxy + tests) ------------- */

/** exact API paths whose non-GET methods require the admin password */
export const ADMIN_WRITE_PATHS = [
  "/api/insights",
  "/api/weekly-review",
  "/api/tvmd",
  "/api/tvmd/login",
  "/api/signal",
] as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requiresAdmin(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (ADMIN_WRITE_PATHS as readonly string[]).includes(p);
}

/* ---- per-IP failure throttle (used by the proxy) ---------------------- */

const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60_000;

export class FailThrottle {
  private fails = new Map<string, { n: number; until: number }>();
  private max: number;
  private windowMs: number;
  constructor(max = MAX_FAILS, windowMs = WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
  }
  blocked(ip: string, now = Date.now()): boolean {
    const f = this.fails.get(ip);
    if (!f) return false;
    if (f.until && now > f.until) {
      this.fails.delete(ip);
      return false;
    }
    return f.n >= this.max;
  }
  fail(ip: string, now = Date.now()): void {
    const f = this.fails.get(ip) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= this.max) f.until = now + this.windowMs;
    this.fails.set(ip, f);
  }
  ok(ip: string): void {
    this.fails.delete(ip);
  }
}

export function clientIp(headers: HeaderBag): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
