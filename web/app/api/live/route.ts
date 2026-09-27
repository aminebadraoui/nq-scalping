import { getLive } from "@/lib/live";

export const dynamic = "force-dynamic";

export async function GET() {
  const feed = getLive();
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
