import { getSnapshot, persistToken, tokenInfo } from "@/lib/tvmd";

export const dynamic = "force-dynamic";

// the platform page (trader.tradovate.com) posts captured tokens
// cross-origin via a console snippet — allow it
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Live snapshot of the Tradovate md collector journal: quote, DOM,
 *  day volume profile, footprint cells, and the recent tick tape. */
export async function GET() {
  return Response.json(getSnapshot(), {
    headers: { "Cache-Control": "no-store", ...CORS },
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
      { status: 400, headers: CORS },
    );
  }
  return Response.json({ ok: true, token: tokenInfo() }, { headers: CORS });
}
