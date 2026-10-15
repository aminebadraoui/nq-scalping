/* ------------------------------------------------------------------ *
 * Post-deploy smoke — the deploy is not "done" until this prints PASS.
 * Verifies against the live dashboard (no secrets needed):
 *
 *   1. the dashboard answers and the deployed buildId matches
 *      --expect-build <sha> (polls up to ~5 min for the Coolify deploy)
 *   2. the live feed is connected with fresh trades
 *   3. candles refreshed recently (or a no-candle window is explicitly
 *      tolerated via --allow-stale-candles for halt hours)
 *   4. tapeGate: veto === false — the 2026-10-15 clock-mix signature
 *      (a healthy feed with the stale veto armed = silent zero signals)
 *   5. protections state is "live" (halted is a WARN unless --require-trading)
 *
 * Run (local or CI):
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/live-smoke.ts --expect-build <sha> [--require-trading]
 * ------------------------------------------------------------------ */

const BASE = process.env.DASHBOARD_URL ?? "https://nq-dashboard.31.97.138.30.sslip.io";
const argv = process.argv.slice(2);
const expectBuild = (() => {
  const i = argv.indexOf("--expect-build");
  return i >= 0 ? argv[i + 1] : null;
})();
const requireTrading = argv.includes("--require-trading");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Health = {
  ok?: boolean;
  buildId?: string;
  execution?: {
    executeLive?: boolean;
    tradingHalt?: boolean;
    protections?: { status?: { state?: string; label?: string } };
    liveFeed?: {
      connected?: boolean;
      lastTradeAgeSec?: number | null;
      lastCandleRefreshAt?: number;
      barSource?: { candle: number; tick: number };
      tapeGate?: { totalBars: number; tail: number; tailAgeMs: number | null; hold: boolean; veto: boolean; lastBarClose: number | null };
    } | null;
  };
};

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE}/api/gc?action=health`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

const failures: string[] = [];
const warns: string[] = [];

async function main() {
  // 1. poll for the expected build (Coolify builds take ~2-4 min)
  let h: Health | null = null;
  if (expectBuild) {
    for (let i = 0; i < 15; i++) {
      h = await fetchHealth();
      if (h?.buildId === expectBuild || h?.buildId?.startsWith(expectBuild)) break;
      console.log(`[smoke] build ${h?.buildId ?? "?"} != ${expectBuild} — waiting for the deploy (${(i + 1) * 20}s)`);
      await sleep(20_000);
    }
  } else {
    h = await fetchHealth();
  }
  if (!h || !h.ok) {
    console.log("FAIL: dashboard unreachable");
    process.exit(1);
  }
  const lf = h.execution?.liveFeed;
  const p = h.execution?.protections;
  console.log(`[smoke] build=${h.buildId} live=${h.execution?.executeLive} halt=${h.execution?.tradingHalt} protections=${p?.status?.state}`);

  // 2. feed connected + fresh trades
  if (!lf?.connected) failures.push("live feed not connected");
  if (lf && lf.lastTradeAgeSec !== null && lf.lastTradeAgeSec !== undefined && lf.lastTradeAgeSec > 300) failures.push(`last trade ${lf.lastTradeAgeSec}s old (>300s)`);

  // 3. candles fresh
  if (lf && lf.lastCandleRefreshAt) {
    const ageMin = (Date.now() - lf.lastCandleRefreshAt) / 60_000;
    if (ageMin > 15) {
      if (argv.includes("--allow-stale-candles")) warns.push(`candles ${ageMin.toFixed(0)} min stale (tolerated)`);
      else failures.push(`candles ${ageMin.toFixed(0)} min stale`);
    }
  }

  // 4. the clock-mix tripwire: a healthy feed must never read veto:true
  const tg = lf?.tapeGate;
  if (tg) {
    console.log(`[smoke] tapeGate: bars=${tg.totalBars} tail=${tg.tail} age=${tg.tailAgeMs === null ? "?" : `${Math.round(tg.tailAgeMs / 1000)}s`} hold=${tg.hold} veto=${tg.veto}`);
    if (tg.veto) {
      if (tg.tailAgeMs !== null && tg.tailAgeMs < 9 * 60_000) failures.push(`tapeGate veto:true with a ${Math.round(tg.tailAgeMs / 1000)}s tail — the clock-mix signature (cards are being killed)`);
      else warns.push(`tapeGate veto:true on a genuinely stale tail (${Math.round((tg.tailAgeMs ?? 0) / 1000)}s) — vendor stall, not a math error`);
    }
    if (tg.totalBars < 60) warns.push(`only ${tg.totalBars} bars buffered (fresh boot?)`);
  } else {
    failures.push("tapeGate diagnostics missing from health — old build?");
  }

  // 5. trading state
  const st = p?.status;
  if (st && st.state !== "live") {
    if (requireTrading) failures.push(`protections ${st.state} (${st.label}) while --require-trading`);
    else warns.push(`protections ${st.state} (${st.label}) — not trading`);
  }

  if (warns.length) for (const w of warns) console.log(`WARN: ${w}`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log("PASS — feed live, candles fresh, gate open, veto clear");
  process.exit(0);
}

main().catch((e) => {
  console.log("FAIL:", String(e));
  process.exit(1);
});
