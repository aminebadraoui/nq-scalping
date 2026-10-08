/* ------------------------------------------------------------------ *
 * Trading halt — the owner's manual kill switch.
 *
 * A dashboard toggle flips this state; the executor's choke points
 * refuse EVERY order while it is set. The state survives redeploys:
 * it is persisted to GC_DATA_DIR/trading-halt.json, re-applied at boot
 * (instrumentation), and applied to process.env instantly so all exec
 * readers see it without a restart. Every flip appends a daybook
 * `exec` audit record — halts and resumes are trackable to the minute.
 *
 * Halting is always allowed (a kill switch must never ask permission).
 * Resuming is password-gated when ADMIN_PASSWORD is configured (see
 * the /api/trading route).
 * ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendDaybook } from "./daybook";
import { sendTelegram } from "./notify";

const HALT_ENV_KEY = "TRADING_HALT";

export function tradingHaltFile(env: Record<string, string | undefined> = process.env): string {
  const dir = env.GC_DATA_DIR || "/app/data";
  return path.join(dir, "trading-halt.json");
}

/** is the manual halt currently set? (env reflects the live state —
 *  the route and the boot hook keep it in sync with the file) */
export function tradingHalted(env: Record<string, string | undefined> = process.env): boolean {
  return env[HALT_ENV_KEY] === "1";
}

/** boot hook: re-apply the persisted halt after a container redeploy —
 *  a halt must survive the process that set it. Best-effort. */
export function loadTradingHalt(env: Record<string, string | undefined> = process.env): void {
  try {
    const p = tradingHaltFile(env);
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, "utf8")) as { halted?: unknown };
    if (j.halted === true) env[HALT_ENV_KEY] = "1";
  } catch {
    /* never block boot on the halt file */
  }
}

/** flip the halt: persist + apply + audit. No-op (no audit noise) when
 *  the state does not change. Throws on filesystem failure so the route
 *  can report it — a halt that claims success without persisting would
 *  silently vanish on the next redeploy. */
export function setTradingHalt(
  halted: boolean,
  env: Record<string, string | undefined> = process.env,
  meta: { actor?: string } = {},
): void {
  if (tradingHalted(env) === halted) return;
  const p = tradingHaltFile(env);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ halted, updatedAt: Date.now() }));
  renameSync(tmp, p);
  if (halted) env[HALT_ENV_KEY] = "1";
  else delete env[HALT_ENV_KEY];
  appendDaybook({
    t: "exec",
    at: Date.now(),
    key: `halt|${Date.now()}`,
    label: halted ? "trading halted (owner)" : "trading resumed (owner)",
    attempt: "initial",
    outcome: halted ? "trading_halted" : "trading_resumed",
    reason: meta.actor ? `by ${meta.actor}` : "dashboard toggle",
  });
  // Telegram knows immediately: one message per flip — signals keep
  // flowing as info-only while halted, and the executor refuses orders
  void sendTelegram(
    halted
      ? "🛑 <b>TRADING HALTED</b> — the owner stopped trading.\nSignal cards will keep arriving for information only; no orders will be placed. Resting limits are cancelled by the watcher."
      : "✅ <b>TRADING RESUMED</b> — the executor will trade again.\nSignal cards are live orders once more.",
    { parseMode: "HTML" },
  ).catch(() => {});
}

/** timing-safe resume-password check. Both sides are trimmed: a
 *  trailing space on the Coolify env var or a copy-pasted password must
 *  never lock the owner out of their own kill switch. No password
 *  configured → true (dashboard access is the gate). Pure + unit-tested. */
export function verifyResumePassword(given: string, configured?: string | null): boolean {
  if (!configured) return true;
  const g = createHash("sha256").update(given.trim()).digest();
  const e = createHash("sha256").update(configured.trim()).digest();
  return timingSafeEqual(g, e);
}

/** TEST ONLY: reset the in-process env key. */
export function __resetTradingHaltForTest(env: Record<string, string | undefined> = process.env): void {
  delete env[HALT_ENV_KEY];
}
