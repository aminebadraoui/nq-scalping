/* The owner's manual trading halt — the dashboard kill switch.
 * POST flips the halt (resume always needs ADMIN_PASSWORD and is refused
 * when none is configured — fail closed; halting is always allowed — a
 * kill switch must never ask permission). GET reports the state AND
 * whether resume is possible, so the UI can adapt instead of guessing. Every flip is
 * audited in the daybook (lib/tradingHalt.ts). */
import { setTradingHalt, tradingHalted, verifyResumePassword } from "@/lib/tradingHalt";

export const dynamic = "force-dynamic";

/* light per-IP throttle on resume attempts — in-memory, per process;
 * enough to make a public dashboard password non-brute-forceable */
const attempts = new Map<string, { n: number; since: number }>();
const THROTTLE_WINDOW_MS = 5 * 60_000;
const THROTTLE_MAX = 10;

function throttled(ip: string): number | null {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.since >= THROTTLE_WINDOW_MS) {
    attempts.set(ip, { n: 1, since: now });
    return null;
  }
  a.n += 1;
  if (a.n > THROTTLE_MAX) return a.since + THROTTLE_WINDOW_MS - now;
  return null;
}

export async function POST(request: Request) {
  try {
    const j = (await request.json()) as { halt?: unknown; password?: unknown };
    if (typeof j.halt !== "boolean") {
      return Response.json({ ok: false, reason: "halt must be a boolean" }, { status: 400 });
    }
    if (!j.halt) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
      const wait = throttled(ip);
      if (wait !== null) {
        return Response.json({ ok: false, reason: `too many attempts — wait ${Math.ceil(wait / 1000)}s` }, { status: 429 });
      }
      if (!verifyResumePassword(typeof j.password === "string" ? j.password : "", process.env.ADMIN_PASSWORD)) {
        return Response.json({ ok: false, reason: "wrong password" }, { status: 401 });
      }
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
  return Response.json({
    ok: true,
    halted: tradingHalted(),
    resumePasswordRequired: true,
    resumeConfigured: !!(process.env.ADMIN_PASSWORD ?? "").trim(),
  });
}
