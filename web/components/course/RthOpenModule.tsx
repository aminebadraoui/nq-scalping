import { Callout } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course modules 03–04 lessons — the RTH card and the Open family.
 * Source of truth: PLAYBOOK.md, lib/softMomentum.ts (SOFT_PROD),
 * lib/openDrive.ts (OPEN_PROD / PULLBACK_PROD / SNIPER_PROD).
 * ------------------------------------------------------------------ */

const RTH_CONDITIONS: Array<[string, string, string]> = [
  ["Window", "the bar prints inside RTH, 9:30–16:00 ET (the 16:00 bar is the last one)", "hourET"],
  ["One-sided", "≥60% of the bar's volume on one side (buy-frac ≥ 0.60 long, ≤ 0.40 short)", "breakFrac"],
  ["Footprint proof", "≥3 dominant cluster rows on the trade side (≥3 lots, ≥2:1)", "domClusters"],
  ["A real bar", "range ≥ 1.0 × ATR14", "breakRangeR"],
  ["Volume", "≥ 0.5 × the trailing 60-bar median", "breakVol · medVol"],
  ["A+ tier", "≥65% one-sided (≥0.65 / ≤0.35) — a label on the card, not a separate gate", "aPlus"],
];

const RTH_STATS: Array<[string, string]> = [
  ["Verified (research optimum)", "10,325 trades · 82.2% WR · PF 3.47 · +3.13 pts net per trade — market entry, structural stop, 0.75R target"],
  ["Per year", "2023 77.7% · 2024 82.8% · 2025 81.9% · 2026 82.2% — every year ≥75%"],
  ["Coverage", "564 of 568 sessions · MFF sim: eval PASS, consistency ✓, never breaches"],
  ["A+ tier alone", "1,699 trades · 80.1% WR · PF 3.07"],
  ["Live bracket", "resting-limit entry · 0.5× stop · 2.5R target → 37.7% WR · PF 1.49 · 9,009 trades (train/OOS/year PASS)"],
];

const DRIVE_STATS: Array<[string, string]> = [
  ["Hit rate", "96% at TP10/SL30 · 93% at TP15/SL35 · median 1 bar to the target"],
  ["Expectancy", "+8.3 / +11.6 pts gross · fires on 87% of days (493/568)"],
  ["The fakeout", "a new extreme WITHOUT the delta backing is never traded — fading it measured negative"],
  ["Scaling", "never scale: at ≥4 contracts the 35-pt stop breaches the account sim"],
];

const PULLBACK_STATS: Array<[string, string]> = [
  ["Verified", "440 trades · 69.8% WR · +5.2 pts net per trade · ~77% of days"],
  ["The instinct, made objective", "every trader's morning pullback feel, converted into three measurable checks"],
];

const SNIPER_STATS: Array<[string, string]> = [
  ["Verified", "longs 52 trades · 55.8% WR · +6.5 pts net · shorts 49 trades · 46.9% · +5.8"],
  ["Coverage", "~1 day in 11 — the rare, high-payoff layer (fixed +45 target measured only +1.1: the flush-extreme target IS the edge)"],
];

function StatList({ stats }: { stats: Array<[string, string]> }) {
  return (
    <ul className="space-y-1.5">
      {stats.map(([l, v]) => (
        <li key={l} className="flex gap-3 text-[13px]">
          <span className="w-36 shrink-0 font-mono text-[11px] text-zinc-500">{l}</span>
          <span className="text-zinc-200">{v}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------ module 03: RTH */

export function RthLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        At 9:30 the tape changes: volume multiplies and both sides fight, so the 75% momentum gates almost
        never complete. The day session rewards a softer setup instead — a 60% one-sided bar whose footprint
        proves real buyers (or sellers) were working the levels.
      </p>

      <Callout tone="info" title="Why a separate card for RTH">
        The research found this by crossing footprint depth with candle impact: in RTH, ≥60% one-sided bars
        with tick-level proof continue; the 75% Globex gates simply never fire there. Trading the momentum card
        in RTH means waiting all day for a bar that does not exist.
      </Callout>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">check — all must hold</th>
              <th className="px-4 py-2 font-normal">the gate</th>
              <th className="px-4 py-2 font-normal">journal key</th>
            </tr>
          </thead>
          <tbody>
            {RTH_CONDITIONS.map(([c, g, k]) => (
              <tr key={k} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-3 text-zinc-300">{c}</td>
                <td className="px-4 py-3 font-mono text-xs text-info">{g}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-500">{k}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["ENTRY", "at the signal bar's close"],
          ["STOP", "the bar's low − 1.0 (short: high + 1.0)"],
          ["TARGET", "0.75R — three quarters of the risk"],
          ["RISK", "3–15 pts · ≥5-bar gap between cards"],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="font-mono text-[10px] text-long">{k}</p>
            <p className="text-sm text-zinc-200">{v}</p>
          </div>
        ))}
      </div>

      <Callout tone="warn" title="The 0.75R lesson — win rate is set by the R-multiple">
        The same setup at a 1R target wins 73.9% of the time; at 0.75R it wins 82.2%. The daytime continuation
        is a <i>small win</i> tape — it reliably travels three quarters of its risk and often stalls before a
        full 1R. Bank the measured distance instead of waiting for a full R the tape does not reliably give.
      </Callout>

      <Callout tone="info" title="The live bracket — how the machine actually trades it today">
        The research bracket above is the measured optimum; live fills drift in the thick tape, so the live card
        rests a <b className="text-zinc-100">limit at the signal price (9-minute TTL)</b>, halves the stop
        (0.5× structural) and stretches the target to <b className="text-zinc-100">2.5R</b>. That is the same
        edge wearing different clothes: ~37.7% wins at a 2.5R payout is still profitable (PF 1.49), exactly as
        the foundations&rsquo; expectancy lesson predicts. When you trade by hand you may use either bracket — but
        pick one and stick to it for the whole session.
      </Callout>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">backtest findings</h4>
        <StatList stats={RTH_STATS} />
      </div>
    </div>
  );
}

/* ------------------------------------------------ module 04: open family */

export function OpenDriveLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        9:30–10:30 ET is the day&rsquo;s information explosion: the opening range forms, the first real delta prints,
        and the day&rsquo;s first moves are born. Three strategies live here. The drive is live on the feed; the
        pullback and sniper are deployed but switched off (FEED_OPEN_PULLBACK=0, FEED_OPEN_SNIPER=0). This
        lesson covers the drive — the next covers the other two.
      </p>

      <h3 className="pt-2 text-base font-bold text-zinc-50">
        🔔 Open drive — the 9:30 scan <span className="font-mono text-xs text-long">LIVE</span>
      </h3>
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        From 9:30, watch the running opening-range high/low and the cumulative delta. The trade is the{" "}
        <b className="text-zinc-200">first bar</b> that pushes a new opening extreme <i>with delta behind it</i>.
      </p>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">condition (long — mirror for short)</th>
              <th className="px-4 py-2 font-normal">the gate</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["A fresh opening-range high", "high > the window's prior high"],
              ["Delta backing the push", "cumulative delta ≥ +300 (short: ≤ −300)"],
              ["A one-sided bar", "buy-frac ≥ 0.55 (short: ≤ 0.45)"],
            ].map(([c, g]) => (
              <tr key={c} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-3 text-zinc-300">{c}</td>
                <td className="px-4 py-3 font-mono text-xs text-info">{g}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["WINDOW", "9:30–9:59 ET"],
          ["ENTRY", "the trigger bar's close"],
          ["STOP", "fixed −35 pts (short: +35)"],
          ["TARGET", "fixed +15 pts (short: −15)"],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="font-mono text-[10px] text-long">{k}</p>
            <p className="text-sm text-zinc-200">{v}</p>
          </div>
        ))}
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        <b className="text-zinc-200">The fakeout is the trap:</b> an opening extreme with no delta behind it is
        NOT traded. Fading it measured negative — the whole point of the ≥300 cum-delta condition is to trade
        only moves with real money behind them.
      </p>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">backtest findings</h4>
        <StatList stats={DRIVE_STATS} />
      </div>
    </div>
  );
}

export function PullbackSniperLesson() {
  return (
    <div className="space-y-6">
      {/* ---- pullback ---- */}
      <div className="space-y-4">
        <h3 className="text-base font-bold text-zinc-50">
          🔔 Open pullback — the morning instinct, made objective{" "}
          <span className="font-mono text-xs text-zinc-500">DEPLOYED · OFF</span>
        </h3>
        <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
          The 9:30–10:30 window (scanning from 9:46). Every trader&rsquo;s instinct is to buy the dip in a trending
          morning; this strategy turns that instinct into three objective checks:
        </p>

        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 font-normal">act</th>
                <th className="px-4 py-2 font-normal">the gate</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["1 · TREND", "the trailing 15-bar cumulative delta is positive (mirror: negative)"],
                ["2 · PULLBACK", "the last bar traded against the trend AND held the prior 5-bar low (mirror: high) within 0.25 AND its counter-delta SHRANK vs the prior bar's |delta| — exhaustion, not a reversal"],
                ["3 · TRIGGER", "the current bar closes back through the pullback's high (mirror: low) with trend-side delta"],
              ].map(([a, g]) => (
                <tr key={a} className="border-b border-zinc-800/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-long">{a}</td>
                  <td className="px-4 py-3 text-zinc-300">{g}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["ENTRY", "the trigger bar's close"],
            ["STOP", "the pullback bar's low − 0.5 (short: high + 0.5)"],
            ["TARGET", "1R"],
            ["RISK", "≤ 25 pts · ≥5-bar gap"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="font-mono text-[10px] text-long">{k}</p>
              <p className="text-sm text-zinc-200">{v}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">backtest findings</h4>
          <StatList stats={PULLBACK_STATS} />
        </div>
      </div>

      {/* ---- sniper ---- */}
      <div className="space-y-4">
        <h3 className="text-base font-bold text-zinc-50">
          🔔 Open sniper — the 9:36:01 trade{" "}
          <span className="font-mono text-xs text-zinc-500">DEPLOYED · OFF</span>
        </h3>
        <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
          The opening range is the first 6 minutes (9:30–9:35); its low/high is the{" "}
          <b className="text-zinc-200">anchor</b>. Then, within 9:36–9:45, a big one-sided flush tries to run
          the anchor and fails to break it — and you rest a limit at the anchor&rsquo;s edge to catch the reversal.
        </p>

        <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 font-normal">check</th>
                <th className="px-4 py-2 font-normal">the gate</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Big volume", "≥ max(300, 1.5 × the 15-bar median)"],
                ["One-sided toward the anchor", "≥55% of volume pushing into it"],
                ["Real aggression", "|delta| ≥ 60"],
                ["The anchor holds", "low ≥ anchor − 1 (mirror: high ≤ anchor + 1)"],
              ].map(([c, g]) => (
                <tr key={c} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-3 text-zinc-300">{c}</td>
                  <td className="px-4 py-3 font-mono text-xs text-info">{g}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["ENTRY", "resting limit at anchor ± 9.5 pts — the market fills it on the retest"],
            ["STOP", "anchor ∓ 10 pts"],
            ["TARGET", "the flush bar's extreme (fixed +45 measured only +1.1 — the flush extreme IS the edge)"],
            ["RISK", "limit fills only on the retest; nothing to do if it never comes back"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="font-mono text-[10px] text-long">{k}</p>
              <p className="text-sm text-zinc-200">{v}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">backtest findings</h4>
          <StatList stats={SNIPER_STATS} />
        </div>
      </div>
    </div>
  );
}
