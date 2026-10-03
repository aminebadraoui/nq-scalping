import { getDom } from "@/lib/dom";

export const dynamic = "force-dynamic";

/** SSE of the live DOM_V2 book + iceberg candidates (mirrors /api/live). */
export async function GET() {
  const feed = getDom();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client gone */
        }
      };
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
