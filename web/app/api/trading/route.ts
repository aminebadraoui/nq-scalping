/* The owner's manual trading halt — the dashboard kill switch.
 * POST flips the halt (resume is password-gated when ADMIN_PASSWORD is
 * configured; halting is always allowed — a kill switch must never ask
 * permission). GET reports the state. Every flip is audited in the
 * daybook (lib/tradingHalt.ts). */
import { createHash, timingSafeEqual } from "node:crypto";
import { setTradingHalt, tradingHalted } from "@/lib/tradingHalt";

export const dynamic = "force-dynamic";

function passwordOk(given: string): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return true; // no password configured — dashboard access is the gate
  const g = createHash("sha256").update(given).digest();
  const e = createHash("sha256").update(pw).digest();
  return timingSafeEqual(g, e);
}

export async function POST(request: Request) {
  try {
    const j = (await request.json()) as { halt?: unknown; password?: unknown };
    if (typeof j.halt !== "boolean") {
      return Response.json({ ok: false, reason: "halt must be a boolean" }, { status: 400 });
    }
    if (!j.halt && !passwordOk(typeof j.password === "string" ? j.password : "")) {
      return Response.json({ ok: false, reason: "resume requires ADMIN_PASSWORD" }, { status: 401 });
    }
    try {
      setTradingHalt(j.halt);
    } catch (e) {
      return Response.json({ ok: false, reason: `cannot persist the halt: ${String(e)}` }, { status: 500 });
    }
    return Response.json({ ok: true, halted: tradingHalted() });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, halted: tradingHalted() });
}
