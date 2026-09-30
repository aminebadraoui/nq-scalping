/**
 * Server boot hook: start the always-on signal feed so Telegram signals flow
 * without a browser being open. The feed also boots the live GoCharting feed
 * and the CBOE options feed (both idempotent), so the whole pipeline is warm
 * from the first request.
 *
 * Also warm the theory-lab sample set in the background: building it is a
 * minutes-long pass over ~570 sessions from R2, and proxies kill long
 * requests, so the first /lab visitor finds the cache already hot.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    const { getSignalFeed } = await import("./lib/signalFeed");
    getSignalFeed();
  } catch {
    /* signals are best-effort — never block the server from starting */
  }
  try {
    const { buildLabSamples } = await import("./lib/lab");
    buildLabSamples().catch(() => {
      /* warm-up is best-effort; /lab rebuilds on demand */
    });
  } catch {
    /* ignore */
  }
}
