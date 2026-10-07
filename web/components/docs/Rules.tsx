import Link from "next/link";

/* The static trading-rules reference — the live counterpart is the
 * /rules board (lib/execStatus.ts deriveRulesView + /api/gc health). */

const ACCOUNT = [
  ["No-data halt", "the account snapshot is unreadable — the gate fails closed and no order can be placed", "always"],
  ["Floor halt", "equity ≤ floor + $500 margin. Eval floor = $50,000 − $2,000 = $48,000 (trails UP at the 17:00 ET close to equity − $2,000); funded trails up and locks at $100", "always"],
  ["Profit target", "eval: equity ≥ $53,000 ($50k + $3k target) → passed, stop. Funded: target measured from $0", "always"],
  ["Consistency cap", "day realized P&L ≥ $900 (30% of the target) → stop for the day", "eval only"],
  ["Daily loss floor", "day P&L ≤ −$250 (DAILY_LOSS_FLOOR) → no new entries for the rest of the day", "always"],
  ["Profit arm", "once day P&L ≥ +$400 (PROFIT_ARM): one trade at a time — the FIRST losing close after arming ends the day", "always"],
  ["Give-back protection", "day P&L gives back more than max($250, 50% × dayPeak) from the day's peak → stop for the day (only after the peak exceeds $250)", "always"],
  ["News halt (T1)", "T1 news windows ±3 min block entries — holding through a T1 release is a funded-account rule breach", "funded only"],
  ["Baseline halt", "a mid-day restart (past the 120-min day-open grace) with the DB AND the guard state file both gone and realized ≠ 0 → refuse to re-baseline the consistency day", "fail-closed"],
  ["Drawdown halving", "challenge drawdown ≥ $600 from the high-water halves the size; restored at ≤ $300 (sizing, not a full stop)", "always"],
] as const;

const SESSION = [
  ["Trading window", "entries only Sunday 18:00 ET → Friday 16:00 ET; Mon–Thu daily 16:00–18:00 ET halt; nothing after 16:00 Friday", "always"],
  ["News blackout", "no card, no order around FOMC (14:00 ET, 10 min before / 20 after) and NFP/CPI/PPI (8:30 ET, 5 before / 10 after)", "all stages"],
  ["Tape gate", "cards hold while the last completed bar is not candle-confirmed; the self-heal ladder recovers the data path (never fails the gate open); the pager alerts on escalation", "all cards"],
] as const;

const CARD = [
  ["RTH daily cap", "max 3 RTH cards per session day — later setups are skipped and journaled to the daybook", "rth family"],
  ["RTH counter-gate", "skip an RTH card within 5 pts of an opposite-side RTH card's WINNING exit in the last 15 min (RTH_COUNTER_GATE_MIN/PTS — owner-approved, full-archive validated)", "rth family"],
  ["Flat requirement", "an entry is refused unless the MNQ book is flat — no stacking on a recent entry or an open position", "all orders"],
  ["Cost-adjusted ticket veto", "TICKET_MIN_EXP_PTS — skip tickets whose expectancy can't clear costs (off by default)", "ticket family"],
  ["Strategy overrides", "lab-approved insights can veto a family (strategyInsights → strategy_overrides)", "per family"],
  ["Feed toggles", "any FEED_* = 0 disables that family entirely", "per family"],
  ["Stale re-send skip", "a verified re-send is skipped when price has moved more than half the risk from the signal", "per trade"],
] as const;

export function RulesSection() {
  const table = (title: string, rows: readonly (readonly [string, string, string])[]) => (
    <div className="mt-6">
      <h3 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[700px] text-left text-sm">
          <tbody>
            {rows.map(([name, what, scope]) => (
              <tr key={name} className="border-t border-zinc-800/70 first:border-t-0 align-top">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-200">{name}</td>
                <td className="px-3 py-2 text-zinc-400">{what}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">{scope}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">08 — trading rules</p>
      <h2 className="text-2xl font-bold tracking-tight text-zinc-50">Everything that stops trading during a day</h2>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        The entry gate (<code className="text-zinc-300">crossGuardGate()</code>) runs before every order and
        fails closed — any account-level rule below means no new entries right now. Card-level vetoes skip one
        card and journal it. The live counterpart of this table (thresholds + live metrics + state dots) is the{" "}
        <Link href="/rules" className="text-long underline decoration-zinc-700 underline-offset-2">
          /rules board
        </Link>
        , fed by <code className="text-zinc-300">/api/gc?action=health</code>.
      </p>

      {table("Account-level halts (checked before every order)", ACCOUNT)}
      {table("Session rules (windows, news, tape)", SESSION)}
      {table("Card-level vetoes (a card is skipped + journaled; trading continues)", CARD)}

      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm leading-relaxed text-zinc-400">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-zinc-500">what is NOT a rule</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            There is <b className="text-zinc-300">no</b> “stop after N consecutive losses” rule — loss streaks
            are capped by the daily loss floor (−$250 ≈ 2–3 losses at current sizing) and the firm's $2,000 max
            loss.
          </li>
          <li>
            “Loss after a winning streak” <b className="text-zinc-300">is</b> covered — by the profit arm: once
            the day crosses +$400, the first losing close ends the day.
          </li>
          <li>
            Streak-aware sizing (×0.5 / ×0.75 per consecutive loss, reset on a win) was studied
            (sizingDynamicsStudy, apPlanSweep) but is not enabled live.
          </li>
          <li>
            The RTH counter-gate is validated on the full 651-session archive (train PF 1.37 vs 1.51 · OOS PF
            0.95 vs 1.36 · account sim +$2,908) —{" "}
            <Link href="/docs#sources" className="text-zinc-300 underline decoration-zinc-700 underline-offset-2">
              docs/research/rth-counter-gate-2026-10-07.md
            </Link>
            .
          </li>
        </ul>
      </div>
    </div>
  );
}
