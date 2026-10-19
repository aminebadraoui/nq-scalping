import { getSnapshot, persistToken, tokenInfo } from "@/lib/tvmd";

export const dynamic = "force-dynamic";

/** Live snapshot of the Tradovate md collector journal: quote, DOM,
 *  day volume profile, footprint cells, and the recent tick tape. */
export async function GET() {
  return Response.json(getSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/** Swap in a freshly captured session token (new demo account, or a
 *  dead chain). Persists to the shared token file — the collector
 *  watches it and hot-restarts with the new session. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!persistToken(token)) {
    return Response.json(
      { ok: false, error: "not a Tradovate session token — paste the JWT from the platform's authorize frame" },
      { status: 400 },
    );
  }
  return Response.json({ ok: true, token: tokenInfo() });
}
