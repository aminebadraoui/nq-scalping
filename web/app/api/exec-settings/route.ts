/* ------------------------------------------------------------------ *
 * /api/exec-settings — the password-gated account control plane.
 *
 *   GET   public status: masked effective account, whether an override
 *         exists, and whether ADMIN_PASSWORD is configured.
 *         ?raw=1 additionally returns the RAW effective account, but
 *         only with `Authorization: Bearer <CROSSTRADE_KEY>` — the jobs
 *         container uses this so its nightly reconcile targets the same
 *         account as the executor without any new credentials.
 *   POST  password-gated account switch:
 *         { password, account, resetGuard?: boolean }
 *         - verifies ADMIN_PASSWORD (timing-safe; 401 when unset)
 *         - validates the account name shape
 *         - writes the runtime override (instant effect, no redeploy)
 *         - resets the account guard to a fresh start (default ON)
 *         - appends a daybook `exec` audit record
 *
 * Brute-force hygiene: fixed failure delay + per-IP throttle
 * (5 failures / 10 min → 429). The gate NEVER reveals whether the
 * password is merely wrong vs. not configured.
 * ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  ACCOUNT_NAME_RE,
  detectGuardResetFor,
  loadExecOverrides,
  maskAccount,
  resetGuardForAccountSwitch,
  verifyAdminPassword,
  writeExecOverride,
} from "@/lib/execOverrides";
import { appendDaybook } from "@/lib/daybook";

export const dynamic = "force-dynamic";

/* ---- shared-secret bearer check (jobs container reads raw account) -- */
function bearerOk(auth: string | null): boolean {
  const key = (process.env.CROSSTRADE_KEY ?? "").trim();
  if (!key || !auth || !auth.startsWith("Bearer ")) return false;
  const given = auth.slice(7).trim();
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(key));
}

/* ---- per-IP failure throttle ----------------------------------------- */
const fails = new Map<string, { n: number; until: number }>();
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60_000;

function throttled(ip: string): boolean {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.until) {
    fails.delete(ip);
    return false;
  }
  return f.n >= MAX_FAILS;
}

function recordFail(ip: string): void {
  const f = fails.get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAILS) f.until = Date.now() + WINDOW_MS;
  fails.set(ip, f);
}

function recordOk(ip: string): void {
  fails.delete(ip);
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("raw") === "1";
  if (raw && !bearerOk(req.headers.get("authorization"))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const override = loadExecOverrides();
  const effective = process.env.CROSSTRADE_ACCOUNT ?? "";
  return Response.json({
    ok: true,
    passwordSet: !!(process.env.ADMIN_PASSWORD ?? "").trim(),
    account: raw ? effective || null : maskAccount(effective),
    override: override.CROSSTRADE_ACCOUNT ? (raw ? override.CROSSTRADE_ACCOUNT : maskAccount(override.CROSSTRADE_ACCOUNT)) : null,
  });
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (throttled(ip)) {
    return Response.json({ ok: false, error: "too many attempts — try again later" }, { status: 429 });
  }
  let body: { password?: unknown; account?: unknown; resetGuard?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!verifyAdminPassword(password)) {
    recordFail(ip);
    // fixed delay: one wrong guess costs the same whether the server has
    // a password configured or not — no oracle for "is it set?"
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ ok: false, error: "bad password" }, { status: 401 });
  }
  const account = typeof body.account === "string" ? body.account.trim() : "";
  if (!ACCOUNT_NAME_RE.test(account)) {
    return Response.json({ ok: false, error: "invalid account name (letters, digits, _ - . space, ≤64)" }, { status: 400 });
  }
  const before = (process.env.CROSSTRADE_ACCOUNT ?? "").trim();

  // decide the guard reset from the LIVE data, not the operator's guess:
  // same Tradovate account under a new name → keep protections; a
  // genuinely different account → reset. `resetGuard === true` forces a
  // reset (the tie-breaker when the snapshot can't settle it).
  const advice = await detectGuardResetFor(account);
  const forceReset = body.resetGuard === true;
  const doReset = forceReset || advice.action === "reset";

  writeExecOverride("CROSSTRADE_ACCOUNT", account);

  let guardReset: { db: "cleared" | "skipped" | "failed" } | null = null;
  if (doReset) guardReset = await resetGuardForAccountSwitch();

  // audit trail: the daybook exec record survives container redeploys
  try {
    appendDaybook({
      t: "exec",
      at: Date.now(),
      key: "account-change",
      label: "exec-settings",
      attempt: "override",
      outcome: "applied",
      reason: `CROSSTRADE_ACCOUNT ${maskAccount(before) ?? "∅"} → ${maskAccount(account)} guard:${guardReset ? `reset(${guardReset.db})` : "kept"} · ${advice.reason}`,
    });
  } catch {
    /* audit is best-effort — the change is already applied */
  }

  recordOk(ip);
  return Response.json({
    ok: true,
    account: maskAccount(account),
    guard: guardReset ? "reset" : "kept",
    guardDb: guardReset?.db ?? null,
    guardReason: guardReset ? `guard reset (${guardReset.db}) — ${advice.reason}` : advice.reason,
  });
}
