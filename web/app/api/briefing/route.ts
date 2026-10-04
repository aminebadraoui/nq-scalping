/* ------------------------------------------------------------------ *
 * /api/briefing — the AI macro briefing card's data route.
 *
 * GET: the latest stored briefing (optionally ?kind=pre-open|post-close|on-demand).
 * POST {action:"refresh"}: regenerate on demand — runs the full
 * pipeline (macro feeds + Neon tape + DeepSeek) with a 10-minute
 * cooldown so a click can never be turned into a spend loop.
 *
 * DISPLAY-ONLY: this route (and lib/macroBriefing.ts, which only this
 * route and scripts/macroBriefing.ts import) never touches the signal
 * engine or the executor.
 * ------------------------------------------------------------------ */

import { generateBriefing, latestBriefing, type BriefingRow } from "@/lib/macroBriefing";
import type { BriefingKind } from "@/lib/briefingText";

export const dynamic = "force-dynamic";

const KINDS: BriefingKind[] = [
  "evening-open",
  "pre-open",
  "post-open",
  "mid-morning",
  "midday",
  "pre-close",
  "post-close",
  "on-demand",
];

const COOLDOWN_MS = 10 * 60 * 1000;
let lastRefreshAt = 0;
let inflight: Promise<{ row: BriefingRow | null; source: string }> | null = null;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const kind: BriefingKind | undefined = KINDS.includes(kindParam as BriefingKind) ? (kindParam as BriefingKind) : undefined;
  const briefing = await latestBriefing(kind);
  return Response.json({ ok: true, briefing, cooldownRemainingMs: Math.max(0, COOLDOWN_MS - (Date.now() - lastRefreshAt)) });
}

export async function POST(req: Request) {
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
    const briefing = await latestBriefing("on-demand");
    return Response.json({ ok: true, briefing, cooldown: true, cooldownRemainingMs: COOLDOWN_MS - since });
  }

  if (inflight) {
    await inflight;
    const briefing = await latestBriefing("on-demand");
    return Response.json({ ok: true, briefing, cooldown: false });
  }

  lastRefreshAt = Date.now();
  inflight = generateBriefing("on-demand").catch((e) => ({ row: null, source: `error: ${String(e)}` }));
  try {
    const { row, source } = await inflight;
    return Response.json({ ok: !!row, briefing: row, source });
  } finally {
    inflight = null;
  }
}
