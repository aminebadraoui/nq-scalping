/* ------------------------------------------------------------------ *
 * /api/macro-interpret — the Macro tab's AI interpretation route.
 *
 * GET: the latest stored interpretation row.
 * POST {action:"refresh"}: regenerate on demand — runs the full
 * pipeline (macro feeds + DeepSeek) with a 10-minute cooldown so a
 * click can never be turned into a spend loop.
 *
 * DISPLAY-ONLY: this route (and lib/macroInterpret.ts, which only this
 * route and scripts/macroInterpret.ts import) never touches the signal
 * engine or the executor.
 * ------------------------------------------------------------------ */

import { generateInterpretation, latestInterpretation, type InterpretRow } from "@/lib/macroInterpret";
import { adminUnauthorized, isAdminRequest } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

const COOLDOWN_MS = 10 * 60 * 1000;
let lastRefreshAt = 0;
let inflight: Promise<{ row: InterpretRow | null; source: string }> | null = null;

export async function GET() {
  const row = await latestInterpretation();
  return Response.json({ ok: true, interpretation: row, cooldownRemainingMs: Math.max(0, COOLDOWN_MS - (Date.now() - lastRefreshAt)) });
}

export async function POST(req: Request) {
  // paid LLM regeneration — admin only (the 10-min cooldown only bounds
  // the spend; it does not stop anyone with the URL from triggering it)
  if (!isAdminRequest(req)) return adminUnauthorized();
  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "refresh") {
    return Response.json({ ok: false, reason: `unknown action "${body.action ?? ""}"` }, { status: 400 });
  }

  const since = Date.now() - lastRefreshAt;
  if (since < COOLDOWN_MS) {
    const row = await latestInterpretation();
    return Response.json({ ok: true, interpretation: row, cooldown: true, cooldownRemainingMs: COOLDOWN_MS - since });
  }

  if (inflight) {
    await inflight;
    const row = await latestInterpretation();
    return Response.json({ ok: true, interpretation: row, cooldown: false });
  }

  lastRefreshAt = Date.now();
  // `fresh` busts the macro feed caches first, so a manual refresh also
  // heals the panels — the new row is built from current upstreams
  inflight = generateInterpretation(true).catch((e) => ({ row: null, source: `error: ${String(e)}` }));
  try {
    const { row, source } = await inflight;
    return Response.json({ ok: !!row, interpretation: row, source });
  } finally {
    inflight = null;
  }
}
