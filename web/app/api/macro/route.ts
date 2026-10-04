/* ------------------------------------------------------------------ *
 * /api/macro — aggregated macro-context payload for the dashboard
 * panels: weekly US news calendar, NQ earnings, Treasury bonds.
 *
 * DISPLAY-ONLY: nothing on this route (or in lib/macroFeed.ts, which
 * only this route imports) feeds the signal engine or the executor.
 * Each source is cached in-process with its own TTL, so the 60s
 * dashboard poll costs nothing upstream.
 * ------------------------------------------------------------------ */

import { getMacroContext } from "@/lib/macroFeed";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getMacroContext();
  return Response.json({ ok: true, ...ctx });
}
