import type { NextRequest } from "next/server";
import { getSignalFeed } from "@/lib/signalFeed";

export const dynamic = "force-dynamic";

/** Live signal + feed status — the server-side mirror of the dashboard's
 *  "final signal" panel, useful for confirming the Telegram loop is warm. */
export async function GET() {
  const feed = getSignalFeed();
  const s = feed.lastSnapshot;
  return Response.json({
    ok: true,
    lastRun: feed.lastRun,
    lastError: feed.lastError,
    live: feed.liveOk,
    note: feed.lastNote,
    signal: s
      ? {
          side: s.signal.side,
          tone: s.signal.tone,
          agree: s.signal.agree,
          verdict: s.signal.verdict,
          headline: s.signal.headline,
          boxes: s.signal.boxes.map((b) => ({ name: b.name, side: b.side, label: b.label ?? null })),
          lastPrice: s.lastPrice,
          timeET: s.timeET,
          day: s.day,
          source: s.source,
          minutes: s.minutes,
          symbol: s.symbol,
          vwap: s.vwap,
          orderflow: { tone: s.mech.tone, verdict: s.mech.verdict, trigger: s.mech.trigger, invalidation: s.mech.invalidation, target: s.mech.target },
          priceaction: s.pa.verdict,
          options: s.opt ? s.opt.note : null,
        }
      : null,
  });
}

/** POST /api/signal?push=1 — force-send the current signal card to Telegram. */
export async function POST(req: NextRequest) {
  const feed = getSignalFeed();
  if (req.nextUrl.searchParams.get("push") === "1") {
    const r = await feed.pushNow();
    return Response.json(r, { status: r.sent ? 200 : 502 });
  }
  return Response.json({ ok: true });
}
