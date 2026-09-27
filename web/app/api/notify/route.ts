import type { NextRequest } from "next/server";
import { sendTelegram } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const j = await req.json();
    text = String(j.text ?? "");
  } catch {
    /* empty body */
  }
  const test = req.nextUrl.searchParams.get("test") === "1";
  if (!text) text = "🧪 GC dashboard test: Telegram wiring works.";
  if (!test) {
    // format alert messages
    if (text.includes("|")) {
      text = "⚠️ GC alert\n" + text.replace(/\s*\|/g, "\n");
    }
  }
  const res = await sendTelegram(text);
  return Response.json(res, { status: res.sent || res.reason.startsWith("Telegram not") ? 200 : 502 });
}
