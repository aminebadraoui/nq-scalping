import { getSignalAudit } from "@/lib/tvmdSignals";

export const dynamic = "force-dynamic";

/** Signal-time feed audit: every emitted/vetoed card stamped with the
 *  GoCharting-vs-Tradovate price delta + skew at its emission instant
 *  (read-only — computed from the daybook journal). */
export async function GET() {
  return Response.json(getSignalAudit(), {
    headers: { "Cache-Control": "no-store" },
  });
}
