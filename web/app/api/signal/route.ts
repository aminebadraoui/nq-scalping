import type { NextRequest } from "next/server";
import { getSignalFeed, FEED_REVERSAL, FEED_SWEEP_RECLAIM, FEED_UNUSUAL_VOLUME, FEED_PULLBACK_TICKET, FEED_MOMENTUM, FEED_OPEN, FEED_OPEN_DRIVE, FEED_OPEN_PULLBACK, FEED_OPEN_SNIPER, FEED_RTH, FEED_GAP_ALERTS } from "@/lib/signalFeed";
import { cardGateOpen } from "@/lib/signals";
import { getSignalHistory } from "@/lib/signalHistory";
import { computeLiveReads } from "@/lib/liveReads";

export const dynamic = "force-dynamic";

/** Live signal + feed status + the history of every Telegram push — the
 *  dashboard's "signal history" panel reads this. The `reads` field adds
 *  the per-strategy live reads (lib/liveReads.ts) that feed the live
 *  signal board — display-only, computed here on request, never on the
 *  dispatch tick. */
export async function GET() {
  const feed = getSignalFeed();
  const s = feed.lastSnapshot;
  const history = await getSignalHistory(100);
  const feeds = {
    reversal: FEED_REVERSAL,
    sweepReclaim: FEED_SWEEP_RECLAIM,
    unusualVolume: FEED_UNUSUAL_VOLUME,
    pullbackTicket: FEED_PULLBACK_TICKET,
    momentum: FEED_MOMENTUM,
    open: FEED_OPEN,
    openDrive: FEED_OPEN_DRIVE,
    openPullback: FEED_OPEN_PULLBACK,
    openSniper: FEED_OPEN_SNIPER,
    rth: FEED_RTH,
    gapAlerts: FEED_GAP_ALERTS,
  };
  // display-only read — a failure here must never take the endpoint down
  let reads = null;
  try {
    reads = await computeLiveReads({ feed, history, feeds });
  } catch (e) {
    console.error("[signal] live reads failed (display-only):", e);
  }
  return Response.json({
    ok: true,
    feeds,
    lastRun: feed.lastRun,
    lastError: feed.lastError,
    live: feed.liveOk,
    note: feed.lastNote,
    history: history.map((h) => ({
      id: h.id,
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
      // post-fire win/loss score (price replay; observational only)
      outcome: h.outcome?.outcome ?? "",
      exitPrice: h.outcome?.exitPrice ?? null,
      exitTime: h.outcome?.exitTime ?? "",
      exitReason: h.outcome?.exitReason ?? "",
      mfePts: h.outcome?.mfePts ?? null,
      maePts: h.outcome?.maePts ?? null,
      // the DOM (iceberg) picture captured at signal time — observational only
      dom: h.features?.dom ?? null,
      // the full feature vector recorded at fire time (signal inputs +
      // study-only context) — the grouped view in SignalHistory reads this
      features: h.features ?? null,
    })),
    reads,
    signal: s
      ? {
          side: s.signal.side,
          tone: s.signal.tone,
          agree: s.signal.agree,
          verdict: s.signal.verdict,
          headline: s.signal.headline,
          // every box, fully — vote, tone, conviction score and verdict text
          boxes: s.signal.boxes.map((b) => ({
            id: b.id,
            name: b.name,
            side: b.side,
            tone: b.tone,
            score: b.score,
            verdict: b.verdict,
            kind: b.kind ?? "directional",
            label: b.label ?? null,
          })),
          contextNotes: s.signal.contextNotes,
          // the card gate's verdict on THIS snapshot — why Telegram would or
          // would not receive the LVN reversal card right now
          gate: cardGateOpen(s.signal, s.mech),
          // the full ingredient checklist inside the order-flow box
          ingredients: s.mech.ingredients.map((i) => ({
            key: i.key,
            n: i.n,
            name: i.name,
            role: i.role,
            state: i.state,
            short: i.short,
            value: i.value,
            why: i.why,
          })),
          present: s.mech.present,
          lastPrice: s.lastPrice,
          timeET: s.timeET,
          day: s.day,
          source: s.source,
          minutes: s.minutes,
          symbol: s.symbol,
          vwap: s.vwap,
          orderflow: { side: s.mech.side, tone: s.mech.tone, verdict: s.mech.verdict, trigger: s.mech.trigger, invalidation: s.mech.invalidation, target: s.mech.target },
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
