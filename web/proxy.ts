/* Next.js 16 proxy (formerly middleware) — the front door for the
 * dashboard's admin-only write endpoints. Non-GET requests to the paths
 * in ADMIN_WRITE_PATHS need the ADMIN_PASSWORD (lib/adminAuth.ts);
 * failures cost a fixed delay and are throttled per IP. Each route
 * re-checks with isAdminRequest() — this file is not the only gate. */
import { NextResponse, type NextRequest } from "next/server";
import { FailThrottle, adminUnauthorized, clientIp, isAdminRequest, requiresAdmin } from "@/lib/adminAuth";

const throttle = new FailThrottle();

export async function proxy(req: NextRequest) {
  if (!requiresAdmin(req.method, req.nextUrl.pathname)) return NextResponse.next();
  const ip = clientIp(req.headers);
  if (throttle.blocked(ip)) {
    return Response.json({ ok: false, reason: "too many attempts — try again later" }, { status: 429 });
  }
  if (!isAdminRequest(req)) {
    throttle.fail(ip);
    await new Promise((r) => setTimeout(r, 400));
    return adminUnauthorized();
  }
  throttle.ok(ip);
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/insights", "/api/weekly-review", "/api/tvmd", "/api/tvmd/login", "/api/signal"],
};
