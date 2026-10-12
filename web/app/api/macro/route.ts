/* ------------------------------------------------------------------ *
 * /api/macro — aggregated macro-context payload for the dashboard
 * panels: weekly US news calendar, NQ earnings, Treasury bonds, the
 * cross-asset watch.
 *
 * GET: the cached context (each source has its own TTL; a failed
 *      source serves its last-good copy and auto-retries after a
 *      cool-down, so panels heal themselves).
 * POST {action:"heal"}: the frontend heal — drops every cached value
 *      and re-reads all upstreams now (2-minute cooldown so a click
 *      can't turn into a rate-limit hammer).
 *
 * DISPLAY-ONLY: nothing on this route (or in lib/macroFeed.ts, which
 * only this route imports) feeds the signal engine or the executor.
 * ------------------------------------------------------------------ */

import { getMacroContext, invalidateMacroCaches, type MacroContext } from "@/lib/macroFeed";

export const dynamic = "force-dynamic";

const HEAL_COOLDOWN_MS = 2 * 60 * 1000;
let lastHealAt = 0;
let healInflight: Promise<MacroContext> | null = null;

export async function GET() {
  const ctx = await getMacroContext();
  return Response.json({ ok: true, ...ctx });
}

export async function POST(req: Request) {
  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "heal") {
    return Response.json({ ok: false, reason: `unknown action "${body.action ?? ""}"` }, { status: 400 });
  }

  const since = Date.now() - lastHealAt;
  if (since < HEAL_COOLDOWN_MS) {
    const ctx = await getMacroContext();
    return Response.json({ ok: true, ...ctx, healCooldown: true, cooldownRemainingMs: HEAL_COOLDOWN_MS - since });
  }

  if (healInflight) {
    await healInflight;
    const ctx = await getMacroContext();
    return Response.json({ ok: true, ...ctx, healCooldown: false });
  }

  lastHealAt = Date.now();
  healInflight = (async () => {
    invalidateMacroCaches();
    return await getMacroContext();
  })();
  try {
    const ctx = await healInflight;
    return Response.json({ ok: true, ...ctx, healCooldown: false, healedAt: new Date().toISOString() });
  } finally {
    healInflight = null;
  }
}
