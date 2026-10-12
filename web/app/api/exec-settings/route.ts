/* ------------------------------------------------------------------ *
 * /api/exec-settings — the password-gated execution control plane.
 *
 *   GET   public status: masked effective account/key/URL, whether
 *         overrides exist, and whether ADMIN_PASSWORD is configured.
 *         ?raw=1 additionally returns the RAW effective values, but
 *         only with `Authorization: Bearer <CROSSTRADE_KEY|ADMIN_PASSWORD>`
 *         — the jobs container uses this so its nightly reconcile
 *         targets the same account with the same key as the executor,
 *         even after a dashboard switch, without new credentials.
 *   POST  password-gated switch of the CrossTrade credentials:
 *         { password, account?, key?, url?, resetGuard?: boolean }
 *         - verifies ADMIN_PASSWORD (timing-safe; 401 when unset)
 *         - validates each provided value's shape (account name,
 *           key token, webhook URL host-locked to app.crosstrade.io)
 *         - writes the runtime overrides (instant effect, no redeploy)
 *         - guard reset is decided from the live snapshot ONLY when
 *           the account name changes (same-name → protections kept;
 *           different realized P&L → fresh-start reset)
 *         - appends a daybook `exec` audit record (values masked)
 *
 * Brute-force hygiene: fixed failure delay + per-IP throttle
 * (5 failures / 10 min → 429), applied to the POST password AND the
 * raw GET. The gate NEVER reveals whether the password is merely
 * wrong vs. not configured.
 * ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  ACCOUNT_NAME_RE,
  CT_KEY_RE,
  CT_URL_RE,
  detectGuardResetFor,
  loadExecOverrides,
  maskAccount,
  maskSecret,
  resetGuardForAccountSwitch,
  stageChangeAdvice,
  verifyAdminPassword,
  writeExecOverride,
  type GuardResetAdvice,
} from "@/lib/execOverrides";
import { appendDaybook } from "@/lib/daybook";

export const dynamic = "force-dynamic";

/* ---- shared-secret bearer check (jobs container reads raw values) ---- */
const sha = (s: string) => createHash("sha256").update(s).digest();

function bearerOk(auth: string | null): boolean {
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const given = auth.slice(7).trim();
  if (!given) return false;
  const key = (process.env.CROSSTRADE_KEY ?? "").trim();
  if (key && timingSafeEqual(sha(given), sha(key))) return true;
  // fall back to the admin password: after a key change via the
  // dashboard, the jobs container's env key is stale — the password
  // (also present in the jobs env) still identifies the operator's
  // automation. Accepting it grants read-only raw access; writes still
  // require the password via POST.
  const admin = (process.env.ADMIN_PASSWORD ?? "").trim();
  return !!admin && timingSafeEqual(sha(given), sha(admin));
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

function ipOf(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("raw") === "1";
  const ip = ipOf(req);
  if (raw) {
    if (throttled(ip)) {
      return Response.json({ ok: false, error: "too many attempts — try again later" }, { status: 429 });
    }
    if (!bearerOk(req.headers.get("authorization"))) {
      recordFail(ip);
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    recordOk(ip);
  }
  const override = loadExecOverrides();
  const key = process.env.CROSSTRADE_KEY ?? "";
  const url = process.env.CROSSTRADE_URL ?? "";
  return Response.json({
    ok: true,
    passwordSet: !!(process.env.ADMIN_PASSWORD ?? "").trim(),
    account: raw ? process.env.CROSSTRADE_ACCOUNT || null : maskAccount(process.env.CROSSTRADE_ACCOUNT ?? ""),
    key: raw ? key || null : maskSecret(key),
    url: raw ? url || null : url ? "https://app.crosstrade.io/…" : null,
    override: {
      CROSSTRADE_ACCOUNT: override.CROSSTRADE_ACCOUNT ? (raw ? override.CROSSTRADE_ACCOUNT : maskAccount(override.CROSSTRADE_ACCOUNT)) : null,
      CROSSTRADE_KEY: override.CROSSTRADE_KEY ? (raw ? override.CROSSTRADE_KEY : maskSecret(override.CROSSTRADE_KEY)) : null,
      CROSSTRADE_URL: override.CROSSTRADE_URL ? (raw ? override.CROSSTRADE_URL : "set") : null,
    },
  });
}

export async function POST(req: NextRequest) {
  const ip = ipOf(req);
  if (throttled(ip)) {
    return Response.json({ ok: false, error: "too many attempts — try again later" }, { status: 429 });
  }
  let body: { password?: unknown; account?: unknown; key?: unknown; url?: unknown; resetGuard?: unknown };
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

  // gather + validate the provided fields (at least one required)
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!account && !key && !url) {
    return Response.json({ ok: false, error: "nothing to change (account, key, or url required)" }, { status: 400 });
  }
  if (account && !ACCOUNT_NAME_RE.test(account)) {
    return Response.json({ ok: false, error: "invalid account name (letters, digits, _ - . space, ≤64)" }, { status: 400 });
  }
  if (key && !CT_KEY_RE.test(key)) {
    return Response.json({ ok: false, error: "invalid secret key (alnum + dash, 16–128 chars)" }, { status: 400 });
  }
  if (url && !CT_URL_RE.test(url)) {
    return Response.json({ ok: false, error: "invalid webhook URL — must be https://app.crosstrade.io/…" }, { status: 400 });
  }

  const before = {
    account: (process.env.CROSSTRADE_ACCOUNT ?? "").trim(),
    key: (process.env.CROSSTRADE_KEY ?? "").trim(),
    url: (process.env.CROSSTRADE_URL ?? "").trim(),
  };

  // guard reset is decided from the LIVE snapshot ONLY when the account
  // NAME changes — a key/URL swap on the same linked account must keep
  // the day's protections (the guard tracks the Tradovate account, not
  // the CrossTrade login). `resetGuard === true` forces the reset.
  // A derived STAGE change (MFFU SF=funded vs EV=eval naming) always
  // resets — different account rules must never inherit the old stage's
  // floor/high-water (the 2026-10-11 funded-switch incident).
  let advice: GuardResetAdvice = { action: "keep", reason: "account name unchanged — protections kept" };
  if (account && account.toUpperCase() !== before.account.toUpperCase()) {
    advice = await detectGuardResetFor(account);
    advice = stageChangeAdvice(before.account, account) ?? advice;
  }
  const forceReset = body.resetGuard === true;
  const doReset = forceReset || advice.action === "reset";

  if (account) writeExecOverride("CROSSTRADE_ACCOUNT", account);
  if (key) writeExecOverride("CROSSTRADE_KEY", key);
  if (url) writeExecOverride("CROSSTRADE_URL", url);

  let guardReset: { db: "cleared" | "skipped" | "failed" } | null = null;
  if (doReset) guardReset = await resetGuardForAccountSwitch();

  // audit trail: the daybook exec record survives container redeploys
  try {
    const changed = [
      account ? `ACCOUNT ${maskAccount(before.account) ?? "∅"}→${maskAccount(account)}` : "",
      key ? `KEY ${maskSecret(before.key) ?? "∅"}→${maskSecret(key)}` : "",
      url ? `URL ${before.url ? "set→set" : "∅→set"}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    appendDaybook({
      t: "exec",
      at: Date.now(),
      key: "exec-settings",
      label: "exec-settings",
      attempt: "override",
      outcome: "applied",
      reason: `${changed} guard:${guardReset ? `reset(${guardReset.db})` : "kept"} · ${advice.reason}`,
    });
  } catch {
    /* audit is best-effort — the change is already applied */
  }

  recordOk(ip);
  return Response.json({
    ok: true,
    account: maskAccount(account || (process.env.CROSSTRADE_ACCOUNT ?? "")),
    key: key ? maskSecret(key) : null,
    url: url ? "set" : null,
    guard: guardReset ? "reset" : "kept",
    guardDb: guardReset?.db ?? null,
    guardReason: guardReset ? `guard reset (${guardReset.db}) — ${advice.reason}` : advice.reason,
  });
}
