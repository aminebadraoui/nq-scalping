/* ------------------------------------------------------------------ *
 * tvmdRecap — pure helpers shared by the VPS autoheal loop
 * (scripts/tvmdRecapture.ts), the dashboard (lib/tvmd.ts) and the
 * tests. No network, no side effects beyond explicit fs helpers.
 *
 * The autoheal loop's durable state lives in two files:
 *   · the token file      — {token, renewedAt, anchoredAt}: `renewedAt`
 *     is bumped by the collector every 20 min (token extensions), so it
 *     can NOT tell us when the chain was last re-anchored by a FRESH
 *     Google-SSO login. `anchoredAt` is written only by the recapture
 *     (or a manual paste) and drives the proactive re-anchor cadence:
 *     demo SSO sessions hit a hard lifetime cap (~24h) that
 *     renewaccesstoken cannot extend past, so the loop must mint a new
 *     session BEFORE the chain breaks.
 *   · the status file     — .recap-status.json: Google-session health,
 *     last heal/failure/alert timestamps, consecutive failure count.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";

export interface RecapStatus {
  /** whether the profile's stored Google session can still complete a
   *  silent SSO (set false only after a browser harvest attempt that
   *  reached the login screen and captured no token) */
  googleSessionOk: boolean;
  /** consecutive failed harvest attempts (drives the backoff ladder) */
  failures: number;
  /** last successful fresh capture (ISO) */
  lastHealAt: string | null;
  /** last harvest attempt (ISO) */
  lastAttemptAt: string | null;
  /** last Telegram alert sent (ISO) — throttles re-alerts */
  lastAlertAt: string | null;
  /** last failure reason (human-readable) */
  lastError: string | null;
}

export function emptyStatus(): RecapStatus {
  return {
    googleSessionOk: true,
    failures: 0,
    lastHealAt: null,
    lastAttemptAt: null,
    lastAlertAt: null,
    lastError: null,
  };
}

/** Backoff ladder in SECONDS for consecutive failed harvests. The 60s
 *  entrypoint tick keeps probing the token (cheap REST call), but the
 *  chromium launch — a fresh headless visit to the platform + Google —
 *  must NOT hammer every minute: repeated datacenter logins are exactly
 *  what gets a Google session flagged and killed. */
const BACKOFF_LADDER = [0, 300, 900, 1800] as const;

export function nextBackoffSeconds(failures: number): number {
  const ix = Math.max(0, Math.min(failures, BACKOFF_LADDER.length - 1));
  return BACKOFF_LADDER[ix];
}

/** Proactive re-anchor rule: recapture when the last FRESH Google-SSO
 *  login is older than anchorHours, even if the token still answers. */
export function shouldReanchor(anchoredAt: string | null, nowMs: number, anchorHours: number): boolean {
  if (!anchoredAt) return true; // never anchored by us — treat as stale
  const at = Date.parse(anchoredAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= anchorHours * 3_600_000;
}

/** Read the token file's anchoredAt (ISO or null). */
export function anchoredAtOf(tokenFile: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(tokenFile, "utf8")) as { anchoredAt?: unknown };
    return typeof raw.anchoredAt === "string" ? raw.anchoredAt : null;
  } catch {
    return null;
  }
}
