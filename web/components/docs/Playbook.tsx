import { Callout, Section } from "@/components/ui";
import { playbookSequence, playbookExecution, dashboardReads, keptVsDropped, measuredEvidence } from "@/lib/data";

/**
 * "How we trade it" — the strategy as actually implemented by the dashboard.
 * Everything here is checkable against the running tool: each row names the
 * surface that shows it.
 */
export function PlaybookSection() {
  return (
    <>
      <Section
        kicker="00 · Our playbook"
        title="How we trade it"
        lede="This is the strategy the dashboard implements — not the research summary. Six conditions in causal order: where a reversal can happen, who is standing there, whether the move has fuel, what actually triggers it, what the raw tape says, and what context forbids. The first, second and fourth are required; everything else is confirmation."
      />

      <section className="mb-12 space-y-3">
        {playbookSequence.map((row) => (
          <div key={row.n} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-xs text-long">{row.n}</span>
              <h3 className="text-lg font-semibold text-zinc-100">{row.name}</h3>
              <span
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  row.required ? "border-long/40 text-long" : "border-zinc-700 text-zinc-500"
                }`}
              >
                {row.required ? "required" : "confirmation"}
              </span>
              <span className="text-sm text-zinc-400">{row.question}</span>
            </div>

            <p className="mb-2 text-sm leading-relaxed text-zinc-300">{row.rule}</p>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border border-zinc-800/70 bg-zinc-950/50 px-3 py-2">
                <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">where you read it</p>
                <p className="font-mono text-[11px] leading-snug text-zinc-300">{row.dashboard}</p>
              </div>
              <div className="rounded border border-short/20 bg-short/5 px-3 py-2">
                <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-short">what it is not</p>
                <p className="font-mono text-[11px] leading-snug text-zinc-400">{row.notThis}</p>
              </div>
            </div>
          </div>
        ))}
      </section>

      <Section
        kicker="Execution"
        title="The trade, in four lines"
        lede="The checklist always shows these four. If any of them is empty, there is nothing to do."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {playbookExecution.map((e) => (
            <div key={e.label} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="mb-1.5 font-mono text-sm font-semibold uppercase tracking-wider text-long">{e.label}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">{e.rule}</p>
            </div>
          ))}
        </div>
        <Callout tone="warn" title="THE SEQUENCE, NOT A PREDICTION">
          The checklist reports what exists and names what is missing. It is a sequence reader for a market that is already
          moving, not a forecast — which is exactly why it can be journalled and falsified trade by trade.
        </Callout>
      </Section>

      <Section kicker="Reading the tool" title="What each panel is for" lede="One question per panel — if a panel is not answering its question, ignore it.">
        <div className="space-y-2">
          {dashboardReads.map((d) => (
            <div key={d.panel} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <p className="mb-1 font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">{d.panel}</p>
              <p className="text-sm leading-relaxed text-zinc-400">{d.read}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        kicker="Evidence"
        title="What the backtest measured — including what failed"
        lede="The full signal was backtested over 683 RTH sessions (Dec 2023 → Sep 2026) with lookahead-free location (prior-day level sheets + a rolling developing profile), 0.5 pt round-trip cost and pessimistic same-bar ordering. Two candidate filters did not survive."
      >
        <div className="space-y-2">
          {measuredEvidence.map((m) => (
            <div key={m.claim} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <span
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                  m.verdict === "holds"
                    ? "border-long/40 text-long"
                    : m.verdict === "weak"
                      ? "border-amber-500/40 text-amber-400"
                      : m.verdict === "fails"
                        ? "border-short/40 text-short"
                        : "border-zinc-700 text-zinc-500"
                }`}
              >
                {m.verdict}
              </span>
              <span className="text-sm font-semibold text-zinc-200">{m.claim}</span>
              <span className="font-mono text-[11px] leading-snug text-zinc-400">{m.measured}</span>
            </div>
          ))}
        </div>
        <Callout tone="warn" title="READ THE FAILURES BEFORE THE RULES">
          Two things failed at full scale and are NOT filters: requiring all 6/6 checklist ingredients (it never fires)
          and absorption one-sidedness ≥ 0.85 (a 30-session fluke). The aligned stack, the entry-bar delta, the tight
          7-pt stop and the POC target are the findings that survived 683 sessions — and they are wired into the live
          signal.
        </Callout>
      </Section>

      <Section
        kicker="Lineage"
        title="What we kept from the research, and what we dropped"
        lede="The original deep-dive surveyed far more than we trade. This is the honest delta."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-long">kept</p>
            {keptVsDropped
              .filter((k) => k.kept)
              .map((k) => (
                <div key={k.kept} className="rounded border border-long/25 bg-long/5 px-3 py-2">
                  <p className="text-sm font-semibold text-zinc-200">{k.kept}</p>
                  <p className="text-xs leading-relaxed text-zinc-400">{k.why}</p>
                </div>
              ))}
          </div>
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-short">dropped</p>
            {keptVsDropped
              .filter((k) => k.dropped)
              .map((k) => (
                <div key={k.dropped} className="rounded border border-zinc-800 px-3 py-2">
                  <p className="text-sm font-semibold text-zinc-300">{k.dropped}</p>
                  <p className="text-xs leading-relaxed text-zinc-500">{k.why}</p>
                </div>
              ))}
          </div>
        </div>
      </Section>
    </>
  );
}
