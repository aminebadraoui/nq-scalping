import { getLive } from "@/lib/live";
import { sseThrottle } from "@/lib/sseThrottle";

export const dynamic = "force-dynamic";

export async function GET() {
  const feed = getLive();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = sseThrottle(
        (data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* client gone */
          }
        },
        // the full state is ~1MB — one event per 2s per client is plenty
        // for the dashboard's panels and keeps the event loop free for
        // detectors + execution during RTH (2026-10-16 saturation outage)
        { gapMs: 2_000 },
      );
      const unsub = feed.subscribe(send);
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          clearInterval(hb);
        }
      }, 15000);
      return () => {
        clearInterval(hb);
        unsub();
      };
    },
    cancel() {
      /* noop */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
