/**
 * Server boot hook: start the always-on signal feed so Telegram signals flow
 * without a browser being open. The feed also boots the live GoCharting feed
 * and the CBOE options feed (both idempotent), so the whole pipeline is warm
 * from the first request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    const { getSignalFeed } = await import("./lib/signalFeed");
    getSignalFeed();
  } catch {
    /* signals are best-effort — never block the server from starting */
  }
}
