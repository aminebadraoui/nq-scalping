import { Callout, Section, StepList } from "@/components/ui";
import { redFlags, strategy1Steps, strategy2, strategy3 } from "@/lib/data";

export function StrategiesSection() {
  return (
    <>
      <Callout tone="info" title="THESE ARE THE RESEARCH PLAYS, NOT OUR PLAYBOOK">
        The three plays below are the generic strategies the deep-dive surveyed — sweep-and-reclaim, absorption fade,
        VWAP/POC reversion. What we actually trade is the six-condition sequence in{" "}
        <a href="#playbook" className="text-long hover:underline">
          Our playbook
        </a>
        , which keeps three ideas from here (location first, the reclaim close as the trigger, absorption as the
        mechanism) and drops the indicator-based regime filters.
      </Callout>
      <Section
        kicker="04 · Strategies studied"
        title="The generic plays we studied"
        lede="All of these are the same underlying edge, renamed over decades: Turtle Soup (Raschke), Trader Vic's 2B (Sperandeo), Wyckoff spring/upthrust, ICT liquidity sweep. Stops cluster beyond obvious levels; a push past them triggers the stops and provides the liquidity for the opposite position. The rules below are what separate the traders who harvest that edge from the ones who get farmed by it."
      />

      <section className="mb-12">
        <div className="mb-4 flex items-center gap-3">
          <h3 className="text-xl font-bold text-zinc-50">
            Sweep-and-reclaim reversal
          </h3>
          <span className="rounded border border-long/40 px-2 py-0.5 font-mono text-xs text-long">
            primary setup
          </span>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
          <StepList steps={strategy1Steps} />
        </div>
      </section>

      <section className="mb-12 grid gap-6 md:grid-cols-2">
        {[strategy2, strategy3].map((s) => (
          <div
            key={s.name}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5"
          >
            <h3 className="mb-4 text-lg font-bold text-zinc-50">{s.name}</h3>
            <ul className="space-y-3">
              {s.steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-info/40 font-mono text-xs text-info">
                    {i + 1}
                  </span>
                  <p className="text-sm leading-relaxed text-zinc-300">{step}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <Section kicker="Red flags" title="What kills all of these" lede="">
        <ul className="grid gap-2 sm:grid-cols-2">
          {redFlags.map((f, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-md border border-short/20 bg-short/5 p-3 text-sm leading-relaxed text-zinc-300"
            >
              <span className="mt-0.5 font-mono text-xs text-short">✕</span>
              {f}
            </li>
          ))}
        </ul>

        <Callout tone="warn" title="THE HONEST BENCHMARK">
          Win rate 45–65% (not 80%+), expectancy +0.2R to +0.9R{" "}
          <em>after fees</em> on the best confluences, ~30% of valid setups
          chopping sideways. Anyone promising more is showing you marketing, not
          data.
        </Callout>
      </Section>
    </>
  );
}
