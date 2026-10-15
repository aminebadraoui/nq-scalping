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
    // runtime execution overrides (the password-gated dashboard account
    // switch) — MUST apply before the daybook boot snapshot and the feed
    // start so the effective CROSSTRADE_ACCOUNT is what everything reads
    const { applyExecOverrides } = await import("./lib/execOverrides");
    applyExecOverrides();
  } catch {
    /* no override file — plain Coolify env governs */
  }
  try {
    // the owner's manual trading halt must survive redeploys
    const { loadTradingHalt } = await import("./lib/tradingHalt");
    loadTradingHalt();
  } catch {
    /* ignore */
  }
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
    // — plus the boot warm: snapshot + hydration preload so the first
    // card of the session skips cold REST/DB hops (best-effort)
    const { startCrossGuardPoll, warmGuardState } = await import("./lib/crossGuard");
    startCrossGuardPoll();
    void warmGuardState().catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    // RTH winner-exit poll: feeds the counter-signal gate's recent-exit
    // log (bracket exits are exchange-side; flat transitions reveal them)
    // — also the 10s protection watchdog (working-stop verification +
    // naked-position repair) and the 5s fill-expectation timer
    const { startRthExitPoll, startWatchTimers } = await import("./lib/execWatch");
    startRthExitPoll();
    startWatchTimers();
  } catch {
    /* ignore */
  }
  try {
    // manual-action detector: manual MNQ round trips + working orders
    // the bot never placed (independent of EXECUTE_LIVE — display/alert
    // only, never touches the book)
    const { startManualDetect } = await import("./lib/manualDetect");
    startManualDetect();
  } catch {
    /* ignore */
  }
  try {
    // CrossTrade WebSocket order-event stream: pushed Rejected/Cancelled
    // events reach the protection layer in <1s, no polling. The pnlUpdate
    // frames stay enabled purely as the stream's liveness heartbeat.
    const { startCtOrderStream } = await import("./lib/ctStream");
    startCtOrderStream();
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
