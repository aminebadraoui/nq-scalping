/* ------------------------------------------------------------------ *
 * Neon quota watchdog — the guard that keeps the 2026-10-08 incident
 * (free-plan data-transfer cap exhausted → project paused, journal and
 * nightly steps blind for days) from ever repeating silently.
 *
 * Reads the project's transfer meter straight from the Neon API (the
 * same `data_transfer_bytes` the console shows), compares it against
 * the free-plan cap, prints the burn rate, and — when the configured
 * threshold is crossed — pages the operator via Telegram (same bot the
 * feed uses) and exits non-zero so the nightly log flags the day.
 *
 * Run from web/ (nightly.sh, only when NEON_API_KEY is present):
 *   node --import scripts/ts-loader.mjs ./scripts/neonQuota.ts
 *
 * Env:
 *   NEON_API_KEY               personal/org key (required; no call without it)
 *   NEON_PROJECT_ID            default: the nq-store project id
 *   NEON_TRANSFER_CAP_BYTES    default: 5 GiB (Neon Free monthly transfer)
 *   NEON_QUOTA_WARN_PCT        default 60 — log a warning line
 *   NEON_QUOTA_PAGE_PCT        default 80 — Telegram page + non-zero exit
 * ------------------------------------------------------------------ */

import { sendTelegram, loadEnv } from "../lib/notify";

const PROJECT_ID = process.env.NEON_PROJECT_ID ?? "proud-waterfall-41356644"; // nq-store2 (nq-store = summer-poetry-26619129)
const CAP = Number(process.env.NEON_TRANSFER_CAP_BYTES ?? 5 * 1024 * 1024 * 1024);
const WARN = Number(process.env.NEON_QUOTA_WARN_PCT ?? 60);
const PAGE = Number(process.env.NEON_QUOTA_PAGE_PCT ?? 80);

const GiB = 1024 * 1024 * 1024;

async function main(): Promise<void> {
  const key = process.env.NEON_API_KEY?.trim();
  if (!key) {
    console.log("[neonQuota] NEON_API_KEY not set — watchdog skipped (add the key to the jobs env to arm it)");
    return;
  }
  const res = await fetch(`https://console.neon.tech/api/v2/projects/${PROJECT_ID}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error(`[neonQuota] API ${res.status} — cannot read the meter`);
    process.exitCode = 2;
    return;
  }
  const j = (await res.json()) as {
    project?: { data_transfer_bytes?: number; quota_reset_at?: string; consumption_period_end?: string };
  };
  const used = j.project?.data_transfer_bytes;
  if (!Number.isFinite(used)) {
    console.error("[neonQuota] project payload missing data_transfer_bytes");
    process.exitCode = 2;
    return;
  }
  const pct = (used! / CAP) * 100;
  const reset = (j.project?.quota_reset_at ?? j.project?.consumption_period_end ?? "?").slice(0, 10);
  const line = `[neonQuota] transfer ${(used! / GiB).toFixed(2)} GiB / ${(CAP / GiB).toFixed(0)} GiB = ${pct.toFixed(1)}% · resets ${reset}`;
  console.log(line);

  if (pct >= WARN) {
    console.warn(`[neonQuota] WARNING: transfer above ${WARN}% — bulk ingest stays off, watch the readthrough`);
  }
  if (pct >= PAGE) {
    const env = loadEnv();
    if (env.TELEGRAM_BOT_TOKEN) {
      const r = await sendTelegram(
        `⚠️ <b>Neon transfer ${pct.toFixed(0)}%</b> (${(used! / GiB).toFixed(2)} GiB of ${(CAP / GiB).toFixed(0)} GiB)\n` +
          `resets ${reset} — if this keeps climbing the project pauses again. Check the nightly log + dashboard readthrough.`,
        { parseMode: "HTML" },
      ).catch(() => ({ sent: false, reason: "send failed" }));
      console.log(`[neonQuota] page ${r.sent ? "sent" : `failed: ${r.reason}`}`);
    } else {
      console.warn("[neonQuota] PAGE threshold crossed but no TELEGRAM_BOT_TOKEN — alert skipped");
    }
    process.exitCode = 1;
  }
}

main();
