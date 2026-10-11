import { RuleBoard } from "@/components/RuleBoard";

/** LIVE RULES — everything that can stop trading today, all three groups
 *  (the /gates and /risk tabs show the session/card and account subsets).
 *  The real gate is crossGuardGate() before every order and fails closed. */
export default function RulesPage() {
  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-6">
      <div className="mb-4">
        <h1 className="font-mono text-xl font-semibold tracking-widest text-zinc-100">
          LIVE RULES — everything that can stop trading today
        </h1>
        <p className="mb-6 mt-2 max-w-3xl text-sm text-zinc-400">
          The real gate is <code className="text-zinc-300">crossGuardGate()</code>, which runs before{" "}
          <b>every</b> order and fails closed — any <span className="text-red-400">BLOCKING</span> row here
          means no new entries right now. Card-level vetoes skip one card and journal it to the daybook.
          The <span className="text-zinc-200">account</span> group is the risk layer (
          <a href="/risk" className="text-long underline decoration-zinc-700 underline-offset-2">/risk</a>
          ); the <span className="text-zinc-200">session</span> + <span className="text-zinc-200">card</span>{" "}
          groups are the regime layer (
          <a href="/gates" className="text-long underline decoration-zinc-700 underline-offset-2">/gates</a>
          ).
        </p>
      </div>

      <RuleBoard groups={["account", "session", "card"]} title="all live rules" />

      <section className="mb-8 max-w-3xl">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">
          Notes — what is NOT a rule
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>
            There is <b>no</b> “stop after N consecutive losses” rule. Loss streaks are capped by the daily
            loss floor (−$250 ≈ 2–3 losses at current sizing) and the firm’s $2,000 max loss.
          </li>
          <li>
            “Loss after a winning streak” IS covered — by the profit arm: once the day crosses +$400, the
            first losing close ends the day.
          </li>
          <li>
            Streak-aware sizing (×0.5 / ×0.75 per consecutive loss, reset on a win) was studied
            (sizingDynamicsStudy, apPlanSweep) but is not enabled live.
          </li>
          <li>
            The RTH counter-gate (MIN15 / PTS5) is owner-approved and validated on the full 651-session
            archive — see docs/research/rth-counter-gate-2026-10-07.md.
          </li>
        </ul>
      </section>
    </div>
  );
}
