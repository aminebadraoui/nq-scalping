import { Callout, Section } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course modules 06–07 — execution and risk management.
 * Source of truth: PLAYBOOK.md (day plan + measured balance),
 * lib/propRules.ts (Rapid EOD 50k), lib/apPlan.ts.
 * ------------------------------------------------------------------ */

const SIZING_ROWS: Array<[string, string, string]> = [
  ["3.5 pts (the floor)", "floor(100 ÷ 7) = 14 micros", "$98 risk · win ≈ +$98"],
  ["4 pts", "floor(100 ÷ 8) = 12 micros", "$96 risk · win ≈ +$96"],
  ["9 pts (the worked example)", "floor(100 ÷ 18) = 5 micros", "$90 risk · win ≈ +$90"],
  ["15 pts (RTH max)", "floor(100 ÷ 30) = 3 micros", "$90 risk · win ≈ +$90"],
  ["20 pts", "floor(100 ÷ 40) = 2 micros", "$80 risk · win ≈ +$80"],
  ["35 pts (the drive's stop)", "floor(100 ÷ 70) = 1 micro", "$70 risk · win ≈ +$30"],
];

const ACCOUNT_ROWS: Array<[string, string]> = [
  ["Account", "MyFundedFutures Rapid EOD 50k, traded with MNQ micros ($2 per point, 0.25-pt tick = $0.50)"],
  ["Max loss limit", "$2,000, END-OF-DAY trailing — the floor only moves up at closes, never intraday"],
  ["Eval stage", "$3,000 profit target · minimum 4 trading days · 30% consistency (no single day may exceed 30% of total profit)"],
  ["Funded stage", "first payout unlocks after a $2,100 buffer (the moment the floor locks at $100) · +$500 per payout after · 90/10 split"],
  ["Measured outcome", "the day plan passes eval in a median ~10 trading days · funded blow-up 0.3% at the 1R plan, 0.0% in 10,000 orderings with the drawdown rule"],
];

const GOAL_ROWS: Array<[string, string, string, string]> = [
  ["RTH 0.75R · 9 contracts", "83%", "56%", "no breaches"],
  ["RTH 1.25×stop / 1R · 9 contracts", "76%", "60%", "no breaches"],
  ["momentum 1R · 9 contracts", "30%", "9%", "no breaches"],
  ["open drive · scaled", "—", "—", "BREACHES — never scale it"],
];

const MISTAKES: Array<[string, string]> = [
  ["Trading the wrong card in the wrong session", "the momentum card in RTH, or the RTH card overnight — the hour gate exists to stop exactly this"],
  ["Entering on the flush itself", "the flush is the probe, not the trade. Wait for the breakout through the reference"],
  ["Skipping the candle-size gate", "one-sided volume in a tiny bar is noise — the 1.0× ATR14 gate is the measured filter"],
  ["Moving or widening the stop after entry", "the stop is structural for a reason; widening buys ~0 expectancy and multiplies exposure"],
  ["Sizing the open drive like the other cards", "its 35-pt stop breaches the account at ≥4 contracts — the $100 formula gives 1 micro, take it"],
  ["Chasing a missed entry", "a card you missed is gone. There is no chase rule, because chasing is trading a different setup"],
  ["Trading into scheduled news", "the feed blacks out around releases for a reason; the news gate ate those cards on purpose"],
  ["Judging a session by one trade", "one clean win proves nothing and one clean loss breaks nothing — the edge is statistical"],
];

export function ExecutionModule() {
  return (
    <section id="execution" className="scroll-mt-20">
      <Section
        kicker="module 06 · from signal to fill"
        title="Execution — the nine-step trade"
        lede="The strategy modules taught you what to look for. This module is the procedure that turns a setup into a managed trade — the same nine steps every time, no exceptions, whether the signal comes from the Telegram card or from your own scan of the chart."
      >
        <ol className="mb-6 space-y-3">
          {[
            ["What time is it?", "Read the clock first, not the chart: Globex → momentum card · 9:30–16:00 → RTH card · 9:30–10:30 → the open family. The session decides which gate list you are even running."],
            ["Scan for the setup bar", "Globex: a ≥70% one-sided flush or a ≥1.6×ATR bar. RTH: a ≥60% one-sided bar. Open: the window high/low with cum-delta. If the feed prints a card, use it — it is the same scan."],
            ["Run every gate, in order", "Walk the module 02–04 tables top to bottom. One failed gate = no trade, and you write down which gate failed (that is what rejectedBy records)."],
            ["Compute the brackets", "Entry = the trigger bar's close. Stop = structural extreme ± pad, widened to the 3.5-pt floor if tighter. Target = R × risk (1R · 0.75R · fixed 15/35 — per strategy)."],
            ["Size the position", "contracts = floor(100 ÷ (risk pts × $2)), minimum 1, cap 30. The table below is the whole job."],
            ["Enter at the close", "The signal is the completed bar. Market at the close for the flush/RTH brackets; resting limit for the expansion retrace (1 pt behind the close, ≤5 bars), the RTH live bracket (9-min TTL) and the sniper anchor limit."],
            ["Place stop and target immediately", "Both orders exist before the fill settles. The bracket was decided before the click — rule zero."],
            ["Journal it", "Record every input from module 05 at signal time (or confirm the feed's card). The journal is what turns ten trades into a measurable edge."],
            ["Review later, never during", "Anatomy review happens after the session: drift, MFE/MAE, stop-runs, loss class. Mid-trade there is nothing to do — the bracket is doing its job."],
          ].map(([t, b], i) => (
            <li key={t} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-xs text-long">
                {i + 1}
              </span>
              <p className="text-sm leading-relaxed text-zinc-300">
                <span className="font-semibold text-zinc-100">{t} — </span>
                {b}
              </p>
            </li>
          ))}
        </ol>

        <Callout tone="long" title="Sizing — the only math you do by hand">
          <p className="mb-3">
            The day plan risks <b className="text-zinc-100">$100 per trade</b>:{" "}
            <span className="font-mono text-xs">contracts = floor(100 ÷ (risk pts × $2))</span>, minimum 1 MNQ,
            capped at 30. Every stop distance maps to exactly one size:
          </p>
          <div className="mb-3 overflow-x-auto rounded border border-zinc-800">
            <table className="w-full min-w-[560px] text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="px-3 py-1.5 font-normal">stop distance</th>
                  <th className="px-3 py-1.5 font-normal">contracts</th>
                  <th className="px-3 py-1.5 font-normal">dollar risk</th>
                </tr>
              </thead>
              <tbody>
                {SIZING_ROWS.map(([a, b, c]) => (
                  <tr key={a} className="border-b border-zinc-800/60 last:border-0">
                    <td className="px-3 py-1.5 text-zinc-300">{a}</td>
                    <td className="px-3 py-1.5 text-long">{b}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            The formula is the whole risk model in one line: bigger stops mean fewer contracts, so every trade
            risks the same dollars. 20 consecutive momentum losers ≈ $2,000 = the max loss limit — the budget is
            set with that line in view, and the daily floor (module 07) cuts the streak long before it compounds.
          </p>
        </Callout>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-400">
            The mistakes that kill the edge — all measured, all avoidable
          </h3>
          <div className="grid gap-2 md:grid-cols-2">
            {MISTAKES.map(([t, b]) => (
              <div key={t} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                <p className="mb-0.5 text-[13px] font-semibold text-short">{t}</p>
                <p className="text-[12px] leading-relaxed text-zinc-400">{b}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </section>
  );
}

export function RiskModule() {
  return (
    <section id="risk" className="scroll-mt-20">
      <Section
        kicker="module 07 · risk management"
        title="The account, the day plan and the measured balance"
        lede="The strategies make money on average; the risk plan is what keeps a bad day from becoming a dead account. Every number here was measured over the same 568-session replay and the full prop-account simulator — nothing is a guess."
      >
        {/* ---- the account ---- */}
        <h3 className="mb-2 text-lg font-bold text-zinc-50">The account the plan is built for</h3>
        <div className="mb-6 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 font-normal">rule</th>
                <th className="px-4 py-2 font-normal">what it means for you</th>
              </tr>
            </thead>
            <tbody>
              {ACCOUNT_ROWS.map(([a, b]) => (
                <tr key={a} className="border-b border-zinc-800/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-zinc-100">{a}</td>
                  <td className="px-4 py-3 leading-relaxed text-zinc-300">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---- the day plan ---- */}
        <h3 className="mb-2 text-lg font-bold text-zinc-50">The day plan — adopted 2026-10-05</h3>
        <Callout tone="long" title="The five rules that run every trading day">
          <ul className="space-y-2">
            <li>
              • <b className="text-zinc-100">All live strategies, regular + A+.</b> Momentum, expansion, RTH and
              open drive all trade; A+ is a card label, never a filter.
            </li>
            <li>
              • <b className="text-zinc-100">$100 risk per trade</b> → the sizing formula from module 06.
              Structural stops; momentum 1R · RTH 0.75R · open drive fixed TP15/SL35.
            </li>
            <li>
              • <b className="text-zinc-100">Daily −$250 floor</b> (<span className="font-mono text-xs">DAILY_LOSS_FLOOR=250</span>):
              once the day&rsquo;s realized P&amp;L crosses −$250, no new entries. The day is over, on purpose.
            </li>
            <li>
              • <b className="text-zinc-100">+$400 one-more-trade arm</b> (<span className="font-mono text-xs">PROFIT_ARM=400</span>):
              once the day reaches +$400, ONE more trade is allowed; a win grants another; the first loss after
              arming ends the day. Green days end with a locked profit.
            </li>
            <li>
              • <b className="text-zinc-100">dd600 → half sizing</b> (<span className="font-mono text-xs">DD_HALF_AT=600 · DD_FULL_AT=300 · DD_HALF_MULT=0.5</span>):
              while the challenge drawdown from the trailing reference is ≥ $600 you trade half size; back to
              full once it recovers to $300. The funded-stage blow-up rate drops to 0.0% with this rule.
            </li>
          </ul>
        </Callout>

        {/* ---- measured balance ---- */}
        <h3 className="mb-2 mt-6 text-lg font-bold text-zinc-50">The measured balance — what the risk sweeps proved</h3>
        <ul className="mb-6 space-y-2 text-sm leading-relaxed text-zinc-300">
          <li>
            • <b className="text-zinc-100">Structural stops everywhere.</b> The stop sits at the bar&rsquo;s own extreme.
            The dedicated sweep (pads 0.25 → 1.5, plus a night pad, 648 sessions) showed widening degrades win
            rate and PF monotonically and worsens the worst-day tail. Safety comes from the 80%+ hit rates, not
            from stop distance.
          </li>
          <li>
            • <b className="text-zinc-100">One measured exception — the 3.5-pt widen floor.</b> Stops tighter than
            3.5 pts live in the weak zone (PF 1.87 vs 2.75) and get swept; widening them back to 3.5 beats both
            skipping and trading them raw. Floors past ~4 pts only add exposure.
          </li>
          <li>
            • <b className="text-zinc-100">Wider stops buy nothing.</b> The momentum 1.5×stop / 1.25×target config
            earned the same +2.45 pts of expectancy while holding trades 5× longer — rejected for exposure, not
            for money.
          </li>
          <li>
            • <b className="text-zinc-100">Never scale the open drive.</b> At ≥4 contracts its 35-pt stop
            breaches the account simulator. It stays at the $100-formula size (1 micro).
          </li>
          <li>
            • <b className="text-zinc-100">Stop-runs are 5% of stops</b> with no hour clustering — a measured
            cost of doing business, not a reason to move stops.
          </li>
        </ul>

        {/* ---- daily goals ---- */}
        <h3 className="mb-2 text-lg font-bold text-zinc-50">Daily goals — the numbers that survive contact</h3>
        <p className="mb-3 max-w-3xl text-sm leading-relaxed text-zinc-400">
          A $200-per-trade minimum is incompatible with these scalps (a win is $80–120; $200 needs 2R targets
          that kill the win rate). The goal the data supports is <b className="text-zinc-200">$500–900 per DAY
          via 2+ trades</b>. Probability of reaching the goal, 2,000 sampled days through the account sim:
        </p>
        <div className="mb-6 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 font-normal">config</th>
                <th className="px-4 py-2 font-normal">P(≥$500)</th>
                <th className="px-4 py-2 font-normal">P(≥$900)</th>
                <th className="px-4 py-2 font-normal">account breach</th>
              </tr>
            </thead>
            <tbody>
              {GOAL_ROWS.map(([a, b, c, d]) => (
                <tr key={a} className="border-b border-zinc-800/60 last:border-0">
                  <td className="px-4 py-3 font-semibold text-zinc-100">{a}</td>
                  <td className="px-4 py-3 font-mono text-long">{b}</td>
                  <td className="px-4 py-3 font-mono text-long">{c}</td>
                  <td className="px-4 py-3 text-zinc-300">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Callout tone="warn" title="The mental rules — the part the machine can't do for you">
          <ul className="space-y-1.5">
            <li>• One trade at a time. The replay never overlapped brackets, and neither do you.</li>
            <li>• Never add to a loser, never average down. The structural stop is the exit; there is no other.</li>
            <li>• −$250 and the day is over — no “one more to get it back”. That trade is exactly the one the floor exists to prevent.</li>
            <li>• +$400 arms one more. A win grants another. The first loss after arming ends the day — bank the green.</li>
            <li>• Journal every card against the baselines in modules 02–04. Ten honest journaled trades beat a hundred remembered feelings.</li>
            <li>• One clean night proves nothing — every number in this course exists because the replay said so across 568 sessions.</li>
          </ul>
        </Callout>
      </Section>
    </section>
  );
}
