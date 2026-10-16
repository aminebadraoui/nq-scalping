/* ------------------------------------------------------------------ *
 * /api/healthz — the lightweight liveness probe (2026-10-16).
 *
 * The Coolify health check used to probe `/` — the heaviest route in
 * the app (full dashboard RSC render + data reads). During the
 * 2026-10-16 RTH saturation the probe timed out 100×, Traefik 503'd
 * the domain, and the orphaned probe curls piled up (647 processes).
 *
 * This route answers 200 from memory alone — no DB, no feed, no
 * render — so the container stays "healthy" as long as the server
 * process serves ANY request. The external watchdog (VPS cron →
 * /root/scripts/nq-watchdog.sh) watches this endpoint and restarts
 * the container after 2 consecutive failures.
 * ------------------------------------------------------------------ */

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    build: process.env.BUILD_SHA || "dev",
    uptimeSec: Math.round(process.uptime()),
    now: Date.now(),
  });
}
