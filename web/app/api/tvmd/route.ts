import { getSnapshot } from "@/lib/tvmd";

export const dynamic = "force-dynamic";

/** Live snapshot of the Tradovate md collector journal: quote, DOM,
 *  day volume profile, footprint cells, and the recent tick tape. */
export async function GET() {
  return Response.json(getSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}
