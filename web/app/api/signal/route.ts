import type { NextRequest } from "next/server";
import { getSignalFeed, FEED_REVERSAL, FEED_SWEEP_RECLAIM, FEED_UNUSUAL_VOLUME, FEED_PULLBACK_TICKET, FEED_MOMENTUM, FEED_OPEN, FEED_RTH } from "@/lib/signalFeed";
import { getSignalHistory } from "@/lib/signalHistory";

export const dynamic = "force-dynamic";

/** Live signal + feed status + the history of every Telegram push — the
 *  dashboard's "signal history" panel reads this. */
export async function GET() {
  const feed = getSignalFeed();
  const s = feed.lastSnapshot;
  const history = await getSignalHistory(100);
  return Response.json({
    ok: true,
    feeds: {
      reversal: FEED_REVERSAL,
      sweepReclaim: FEED_SWEEP_RECLAIM,
      unusualVolume: FEED_UNUSUAL_VOLUME,
      pullbackTicket: FEED_PULLBACK_TICKET,
      momentum: FEED_MOMENTUM,
      open: FEED_OPEN,
      rth: FEED_RTH,
    },
    lastRun: feed.lastRun,
    lastError: feed.lastError,
    live: feed.liveOk,
    note: feed.lastNote,
    history: history.map((h) => ({
      ts: h.ts,
      timeET: h.timeET,
      day: h.day,
      symbol: h.symbol,
      side: h.side,
      price: h.price,
      entry: h.entry,
      stop: h.stop,
      target: h.target,
      size: h.size,
      verdict: h.verdict,
      headline: h.headline,
      source: h.source,
      test: h.test,
      sent: h.sent,
      reason: h.reason,
    })),
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
          pullback: { side: s.pb.side, tone: s.pb.tone, verdict: s.pb.verdict, trigger: s.pb.trigger, invalidation: s.pb.invalidation, target: s.pb.target },
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
