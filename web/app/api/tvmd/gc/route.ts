import { getLive } from "@/lib/live";

export const dynamic = "force-dynamic";

/** Slim GoCharting TRADE-feed state for the /tvmd comparison panel:
 *  last print (price + ms), vendor day snapshot, live minute bar, and
 *  the recent tick ring. The trade socket is the healthy one — the
 *  separate DOM_V2 (depth) socket has been vendor-dead since 2026-10-07
 *  and is irrelevant to signal-time price comparison. */
export async function GET() {
  const st = getLive().state;
  return Response.json(
    {
      ok: true,
      connected: st.connected,
      lastMessage: st.lastMessage,
      lastTradeMs: st.lastTradeMs,
      lastVolChangeMs: st.lastVolChangeMs,
      lastCandleRefreshAt: st.lastCandleRefreshAt,
      ltp: st.snapshot?.ltp ?? null,
      dayVolume: st.snapshot?.volume ?? null,
      dayDelta: st.snapshot?.delta ?? null,
      cur: st.cur
        ? {
            t: st.cur.t,
            du: st.cur.du ?? null,
            c: st.cur.c,
            h: st.cur.h,
            l: st.cur.l,
            vol: st.cur.vol,
            buy: st.cur.buy,
            sell: st.cur.sell,
            source: st.cur.source ?? null,
          }
        : null,
      ticks: st.ticks.slice(-12).map((tk) => ({ ms: tk.ms, ltp: tk.ltp, size: tk.size, side: tk.side })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
