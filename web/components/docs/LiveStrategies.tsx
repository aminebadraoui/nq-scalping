import { Callout, Section } from "@/components/ui";

/** live FEED_* switch states as served by /api/gc?action=health */
export type FeedFlags = {
  momentum?: boolean;
  bigbar?: boolean;
  rth?: boolean;
  open?: boolean;
  openDrive?: boolean;
  openPullback?: boolean;
  openSniper?: boolean;
  reversal?: boolean;
  sweepReclaim?: boolean;
  pullbackTicket?: boolean;
  unusualVolume?: boolean;
  gapAlerts?: boolean;
};

type Strategy = {
  emoji: string;
  name: string;
  /** static status, used when no live feed flags are available (docs page) */
  status: string;
  /** the FEED_* flags that control this strategy — every one must be ON for it to fire */
  feeds?: (keyof FeedFlags)[];
  window: string;
  conditions: string[];
  mechanics: { entry: string; stop: string; target: string; risk: string; gap?: string };
  stats: { label: string; value: string }[];
  note?: string;
};

const STRATEGIES: Strategy[] = [
  {
    emoji: "⚡",
    name: "MOMENTUM — Failed-Flush Breakout + Huge-Bar Expansion",
    status: "LIVE",
    feeds: ["momentum"],
    window: "Globex only · 18:00 → 9:30 ET (RTH 9:30–16:00 excluded)",
    conditions: [
      "TRIGGER A — failed-flush breakout: a bar with ≥70% one-sided volume (buy-frac ≤0.30 for longs) and volume ≥ max(15, ½×60-bar median, 250)",
      "…that makes NO new session low (low ≥ session low −0.5) — effort without result. A flush that breaks the low is a real breakdown: the machine resets.",
      "…then, within 10 bars, a bar with ≥75% one-sided volume in the trade direction that trades THROUGH the reference (max high of the flush bar + the 2 bars before it; mirror for lows). No separate response bar required (merged mode).",
      "Candle-size gate: the breakout bar's range must be ≥0.85× ATR14.",
      "TRIGGER B — huge-bar expansion: a bar with range ≥1.6× ATR14, |delta|÷volume ≥0.5 (≥75% one-sided), and ≥3 dominant cluster rows (≥3 lots, ≥2:1) on the trade side.",
      "A+ marker: both triggers fire on the same bar — the highest-conviction subset (78.9% WR, PF 3.23). The day's first card is marked “1st today” (that subset: 77.2% WR, PF 3.15).",
    ],
    mechanics: {
      entry: "trigger bar's close",
      stop: "trigger bar's low −0.5 (short: high +0.5) · stops tighter than 3.5 pts widen to entry ∓3.5 (1R target follows) · under 3 pts never trades",
      target: "1R (1 × entry-to-stop distance)",
      risk: "3–30 pts · ≥5-bar gap",
    },
    stats: [
      { label: "Combined card", value: "4,822 trades · 77.5% WR · PF 2.98 · +11,680 pts net" },
      { label: "Per year", value: "2024 80.0% · 2025 75.3% · 2026 (out-of-sample) 77.9%" },
      { label: "By direction", value: "long 78.5% (PF 3.08) · short 76.4% (PF 2.88)" },
      { label: "Sequential replay", value: "one trade at a time — only ~1% of signals overlap; edge intact" },
    ],
  },
  {
    emoji: "🔷",
    name: "BIG-BAR — first ≥100-pt bar continuation (family D)",
    status: "LIVE",
    feeds: ["bigbar"],
    window: "all hours · one candidate per session (news-blackout bars skip)",
    conditions: [
      "TRIGGER: the session's FIRST bar with range ≥100 pts, past the first 30 bars",
      "DIRECTION: the bar's delta sign (buy − sell ≠ 0) — the footprint's one-sided proof on the macro minute",
      "ENTRY: resting limit AT the bar's close (the flush-limit path — no marketable chase), TTL 9 min, cancelled if untraded",
    ],
    mechanics: {
      entry: "resting limit at the trigger bar's close, TTL 9 min",
      stop: "fill ∓ max(3.5, ATR14) pts",
      target: "1R from the fill · 60-bar time exit",
      risk: "≈29 pts on macro days → 1 micro at the $100 budget",
    },
    stats: [
      { label: "Verified (live limit arm)", value: "107 trades · 57.0% WR · PF 1.42 · +4.63 pts per trade · train/test 52/62" },
      { label: "Coverage", value: "~1 trade per 1.1 weeks — only days whose tape prints a 100-pt minute" },
      { label: "The catch", value: "the market-entry arm (76.5% WR, PF 3.74) is the unreachable close-fill ideal — the live card rests a limit" },
    ],
  },
  {
    emoji: "🟦",
    name: "SESSION CONTINUATION — footprint-proven continuation",
    status: "LIVE",
    feeds: ["rth"],
    window: "cash hours only · 9:30 → 16:00 ET (ends at the 16:00 closing bar)",
    conditions: [
      "A bar in cash hours with ≥60% one-sided volume (buy-frac ≥0.60 for longs; mirror ≤0.40)",
      "≥3 dominant cluster rows on the trade side (≥3 lots, ≥2:1) — the tick-level proof",
      "Range ≥1.0× ATR14 (the candle-size gate)",
      "Volume ≥0.5× the trailing 60-bar median",
      "A+ tier: ≥65% one-sided — 1,699 trades, 80.1% WR, PF 3.07 (card prints “A+”)",
    ],
    mechanics: {
      entry: "research: trigger bar's close (market) · LIVE: resting limit at the signal price, TTL 9 min",
      stop: "research: trigger bar's low −1.0 (short: high +1.0) · LIVE: 0.5× structural",
      target: "research optimum: 0.75R (1R scores 73.9%; 0.75R scores 82%) · LIVE: 2.5R — win rate is set by the R-multiple, not the edge",
      risk: "3–15 pts · ≥5-bar gap",
    },
    stats: [
      { label: "Verified (research optimum)", value: "10,325 trades · 82.2% WR · PF 3.47 · +3.13 pts net per trade — market entry, structural stop, 0.75R target" },
      { label: "Per year", value: "2023 77.7% · 2024 82.8% · 2025 81.9% · 2026 82.2% — every year ≥75%" },
      { label: "Sessions", value: "564 of 568 · MFF sim: eval PASS, consistency ✓, never breaches" },
      { label: "LIVE bracket (2026-10-06 redesign)", value: "market entries failed under drift-aware fills → resting-limit entry (TTL 9 min) · 0.5× stop · 2.5R target · ~37% WR by design (rthLimitValidation: train/OOS/year PASS)" },
      { label: "Found via", value: "footprint × candle-impact interaction study (scripts/rthImpact.ts), independently re-verified (verifyRthDump.ts)" },
    ],
  },
  {
    emoji: "🔔",
    name: "OPEN DRIVE — the 9:30 scan",
    status: "LIVE",
    feeds: ["open", "openDrive"],
    window: "9:30 → 9:59 ET",
    conditions: [
      "Track the running opening-range high/low and cumulative delta from 9:30",
      "Fire on the FIRST bar where: high > prior window high AND cumD ≥ +300 AND buy-frac ≥0.55 → LONG (mirror: low < prior window low, cumD ≤ −300, buy-frac ≤0.45 → SHORT)",
      "The fakeout (new extreme WITHOUT delta backing) is never traded — fading it measured negative",
    ],
    mechanics: {
      entry: "trigger bar's close",
      stop: "fixed −35 pts from entry (short: +35)",
      target: "fixed +15 pts (short: −15)",
      risk: "fixed plan",
    },
    stats: [
      { label: "Hit rate", value: "96% at TP10/SL30 · 93% at TP15/SL35 · median 1 bar to TP" },
      { label: "Expectancy", value: "+8.3 / +11.6 pts gross · 87% of days (493/568)" },
      { label: "Warning", value: "never scale: at ≥4 contracts the 35-pt stop breaches the account sim" },
    ],
  },
  {
    emoji: "🔔",
    name: "MORNING PULLBACK — the morning instinct, objective",
    status: "DEPLOYED — OFF (FEED_OPEN_PULLBACK=0)",
    feeds: ["open", "openPullback"],
    window: "9:30 → 10:30 ET",
    conditions: [
      "TREND: the trailing 15-bar cumulative delta is positive (mirror: negative)",
      "PULLBACK: the last bar traded against the trend AND held the prior 5-bar low (mirror: high) within 0.25 AND its counter-delta SHRANK vs the prior bar's |delta| (exhaustion)",
      "TRIGGER: the current bar closes back through the pullback's high (mirror: low) with trend-side delta",
    ],
    mechanics: {
      entry: "trigger bar's close",
      stop: "pullback bar's low −0.5 (short: high +0.5)",
      target: "1R",
      risk: "≤25 pts · ≥5-bar gap",
    },
    stats: [
      { label: "Verified", value: "440 trades · 69.8% WR · +5.2 pts net per trade" },
      { label: "Coverage", value: "~77% of days (9:30–10:30 window)" },
    ],
  },
  {
    emoji: "🔔",
    name: "9:36 SNIPER — the 9:36:01 trade",
    status: "DEPLOYED — OFF (FEED_OPEN_SNIPER=0)",
    feeds: ["open", "openSniper"],
    window: "9:36 → 9:45 ET",
    conditions: [
      "Opening range = the first 6 minutes (9:30–9:35); anchor = its low/high",
      "FLUSH: volume ≥ max(300, 1.5×15-bar median), ≥55% one-sided toward the anchor, |delta| ≥60, and it HOLDS the anchor (low ≥ anchor −1; mirror: high ≤ anchor +1)",
      "The card prints a resting-limit ticket — you rest the order, the market fills it",
    ],
    mechanics: {
      entry: "resting limit at anchor ±9.5 pts",
      stop: "anchor ∓10 pts",
      target: "the flush bar's extreme (the measured optimum; fixed +45 scores only +1.1)",
      risk: "limit fills only on the retest",
    },
    stats: [
      { label: "Verified", value: "longs 52 trades · 55.8% WR · +6.5 pts net · shorts 46.9% / +5.8" },
      { label: "Coverage", value: "~1 day in 11 — the rare, high-payoff sniper layer" },
    ],
  },
  {
    emoji: "⚠",
    name: "UNUSUAL VOLUME — heads-up, never a trade",
    status: "OFF (owner: Telegram = trade signals only)",
    feeds: ["unusualVolume"],
    window: "all hours",
    conditions: [
      "A completed minute with volume ≥2× its hour's median AND ≥70% one-sided",
      "Prints the volume multiple, one-sided %, and the failed-flush watch line when the bar fails to make a new extreme: “no new session low” or “no new local low (20 bars)” + the breakout reference price",
      "Footer lists every strategy's win rate: momentum 77.5% · session continuation 37.7% · drive 96% · pullback 69.8% · sniper 55.8%",
    ],
    mechanics: { entry: "—", stop: "—", target: "—", risk: "no trade ticket attached" },
    stats: [{ label: "Status", value: "FEED_UNUSUAL_VOLUME=0 · FEED_PULLBACK_TICKET=0" }],
  },
];

const RETIRED: { name: string; note: string; feeds?: (keyof FeedFlags)[] }[] = [
  { name: "LVN Reversal Box", note: "the original fade playbook — docs/strategy/STRATEGY.md; the box pipeline (order flow + price action + options) with the 3-required + confirmation card gate", feeds: ["reversal"] },
  { name: "Sweep-Reclaim Fade", note: "session-extreme fades — retired because it fired shorts into one-sided runs", feeds: ["sweepReclaim"] },
  { name: "Pullback-exhausted ticket", note: "the trade ticket inside the unusual-volume watch", feeds: ["pullbackTicket"] },
  { name: "Open daily rule + strict drive", note: "superseded config modes in lib/openDrive.ts (79% hit every day / 92% hit ~1 day in 8)" },
];

function statusFor(s: Strategy, feeds: FeedFlags | null): { text: string; cls: string } {
  if (!feeds) {
    // static docs render
    const tone = s.status.startsWith("LIVE") ? "emerald" : "zinc";
    return { text: s.status, cls: tone === "emerald" ? "border-emerald-500/40 text-emerald-400" : "border-zinc-600 text-zinc-400" };
  }
  const keys = s.feeds ?? [];
  if (keys.length === 0) return { text: s.status, cls: "border-zinc-600 text-zinc-400" };
  const on = keys.every((k) => feeds[k] === true);
  return on
    ? { text: "ON — live", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" }
    : { text: `OFF — ${keys.join(" + ")} disabled`, cls: "border-zinc-600 bg-zinc-900/40 text-zinc-400" };
}

export function LiveStrategiesSection({ feeds = null }: { feeds?: FeedFlags | null }) {
  const callout = feeds
    ? `⚡ momentum ${feeds.momentum ? "ON" : "OFF"} · 🔷 big-bar ${feeds.bigbar ? "ON" : "OFF"} · 🟦 session continuation ${feeds.rth ? "ON" : "OFF"} · 🔔 open master ${feeds.open ? "ON" : "OFF"} (drive ${feeds.openDrive ? "ON" : "OFF"}, pullback ${feeds.openPullback ? "ON" : "OFF"}, sniper ${feeds.openSniper ? "ON" : "OFF"}) · ⚠ unusual volume ${feeds.unusualVolume ? "ON" : "OFF"} · gap alerts ${feeds.gapAlerts ? "ON" : "OFF"} · reversal ${feeds.reversal ? "ON" : "OFF"} / sweep-reclaim ${feeds.sweepReclaim ? "ON" : "OFF"} / pullback ticket ${feeds.pullbackTicket ? "ON" : "OFF"} — read live from this server's environment.`
    : "⚡ momentum ON · 🔷 big-bar ON · 🟦 session continuation ON · 🔔 open master ON (drive ON, pullback/sniper OFF) · ⚠ unusual volume OFF · gap alerts OFF · reversal / sweep-reclaim / pullback ticket OFF.";

  return (
    <>
      <Section
        kicker="Live strategies"
        title="Every strategy, condition by condition"
        lede="What the feed actually trades right now — each condition is exactly what the code checks, and every number is the backtest result over the same 568-session archive (2023-12 → 2026-09, lookahead-free, 0.5 pt round-trip cost, pessimistic first-touch scoring, sequential one-trade-at-a-time replay, MyFundedFutures Rapid EOD 50k account simulator)."
      />

      <Callout tone="info" title={feeds ? "LIVE FEED RIGHT NOW — from this server" : "LIVE FEED RIGHT NOW"}>{callout}</Callout>

      <div className="space-y-10">
        {STRATEGIES.map((s) => {
          const st = statusFor(s, feeds);
          return (
            <section key={s.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h3 className="text-xl font-bold text-zinc-50">
                  {s.emoji} {s.name}
                </h3>
                <span className={`rounded border px-2 py-0.5 font-mono text-xs ${st.cls}`}>{st.text}</span>
              </div>
              <p className="mb-4 font-mono text-[11px] text-zinc-500">{s.window}</p>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">conditions — all must hold</p>
              <ol className="mb-4 space-y-2">
                {s.conditions.map((c, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-info/40 font-mono text-xs text-info">
                      {i + 1}
                    </span>
                    <p className="text-sm leading-relaxed text-zinc-300">{c}</p>
                  </li>
                ))}
              </ol>
              <div className="mb-4 grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["ENTRY", s.mechanics.entry],
                  ["STOP", s.mechanics.stop],
                  ["TARGET", s.mechanics.target],
                  ["RISK", s.mechanics.risk],
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="font-mono text-[10px] text-long">{k}</p>
                    <p className="text-sm text-zinc-200">{v}</p>
                  </div>
                ))}
              </div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">backtest findings</p>
              <ul className="space-y-1.5">
                {s.stats.map((st, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="w-32 shrink-0 font-mono text-[11px] text-zinc-500">{st.label}</span>
                    <span className="text-zinc-200">{st.value}</span>
                  </li>
                ))}
              </ul>
              {s.note ? <p className="mt-3 text-sm italic text-zinc-400">{s.note}</p> : null}
            </section>
          );
        })}
      </div>

      <section className="mt-10 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="mb-4 text-xl font-bold text-zinc-50">Retired / archived</h3>
        <ul className="space-y-2">
          {RETIRED.map((r) => {
            const on = feeds && r.feeds ? r.feeds.every((k) => feeds[k] === true) : null;
            return (
              <li key={r.name} className="flex gap-3 text-sm">
                <span className="w-44 shrink-0 font-mono text-[11px] text-zinc-500">{r.name}</span>
                <span className="min-w-0">
                  <span className="text-zinc-300">{r.note}</span>
                  {on !== null && (
                    <span className={`ml-2 rounded border px-1.5 py-0.5 font-mono text-[10px] ${on ? "border-emerald-500/40 text-emerald-400" : "border-zinc-700 text-zinc-500"}`}>
                      {on ? "ENABLED" : "off"}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-10 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="mb-4 text-xl font-bold text-zinc-50">Sizing & risk management — the measured balance</h3>
        <ul className="space-y-2 text-sm text-zinc-300">
          <li>• Momentum + Session Continuation size <span className="text-zinc-100">9 contracts fixed</span> (median day +$347; worst real day −$619; 0% annual breach over 20,000 simulated accounts). <span className="font-mono text-zinc-500">FIXED_CONTRACTS</span> env overrides.</li>
          <li>• The open family keeps the <span className="text-zinc-100">$170-budget sizing</span> (~2 MNQ) — the drive's 35-pt stop breaches at ≥4 contracts, so the code refuses to scale it.</li>
          <li>• <span className="text-zinc-100">Structural stops everywhere</span>: widening stops measured +0.00 pts of expectancy while multiplying exposure up to 13×. Safety comes from the 80%+ hit rates, not from stop distance.</li>
          <li>• <span className="text-zinc-100">$200-per-trade minimum is incompatible</span> with these scalps at ≤9 contracts (a win is $80–120); the goal that survives the data is <span className="text-zinc-100">$500–900 per DAY via 2+ trades</span> — Session Continuation at 9 contracts delivers P(≥$500)=83% and P(≥$900)=56% of days with zero breaches.</li>
          <li>• MFF Rapid EOD 50k on every trade: $2,000 EOD-trailing MLL with the $100 lock, 30% consistency, $2,100 buffer / $500 payout steps — simulated in every backtest.</li>
        </ul>
      </section>
    </>
  );
}
