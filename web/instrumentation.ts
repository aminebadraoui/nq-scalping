/**
 * Server boot hook: start the always-on signal feed so Telegram signals flow
 * without a browser being open. The feed also boots the live GoCharting feed
 * and the CBOE options feed (both idempotent), so the whole pipeline is warm
 * from the first request.
 *
 * Also warm the theory-lab sample set in the background: building it is a
 * minutes-long pass over ~570 sessions from R2, and proxies kill long
 * requests, so the first /lab visitor finds the cache already hot. Disabled
 * by LAB_ENABLED=false (the VPS never runs the research lab).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  try {
    // daybook boot record: the variation fingerprint + full settings
    // snapshot, written before anything trades (best-effort, never throws)
    const { bootDaybook } = await import("./lib/daybook");
    bootDaybook();
  } catch {
    /* ignore */
  }
  try {
    // guard day-P&L keep-alive: day tracking stays live between entries
    // (the entry gate itself is unchanged — the poll's verdict is logged)
    const { startCrossGuardPoll } = await import("./lib/crossGuard");
    startCrossGuardPoll();
  } catch {
    /* ignore */
  }
  try {
    // RTH winner-exit poll: feeds the counter-signal gate's recent-exit
    // log (bracket exits are exchange-side; flat transitions reveal them)
    const { startRthExitPoll } = await import("./lib/execWatch");
    startRthExitPoll();
  } catch {
    /* ignore */
  }
  try {
    const { getSignalFeed } = await import("./lib/signalFeed");
    getSignalFeed();
  } catch {
    /* signals are best-effort — never block the server from starting */
  }
  try {
    // DOM_V2 L2 feed + iceberg detector — booted warm so the book is ready
    // when the dashboard first asks (best-effort, idempotent singleton)
    const { getDom } = await import("./lib/dom");
    getDom();
  } catch {
    /* ignore */
  }
  if (process.env.LAB_ENABLED === "false") return;
  try {
    const { buildLabSamples } = await import("./lib/lab");
    buildLabSamples().catch(() => {
      /* warm-up is best-effort; /lab rebuilds on demand */
    });
  } catch {
    /* ignore */
  }
}
