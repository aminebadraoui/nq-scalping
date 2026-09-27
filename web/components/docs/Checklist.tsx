import Checklist from "@/components/Checklist";
import ExpectancyCalculator from "@/components/ExpectancyCalculator";
import { Callout, Section } from "@/components/ui";
import { benchmarkNote, riskRules, validationProtocol } from "@/lib/data";

export function ChecklistSection() {
  return (
    <>
      <Section
        kicker="04 · Desk tool"
        title="Reversal confirmation checklist"
        lede="Run this before every reversal entry. Progress persists in your browser. Confirm as many as possible — at minimum: Location, Event, and Confirmation (the reclaim close)."
      >
        <Checklist />
        <p className="mt-4 text-sm leading-relaxed text-zinc-500">
          {benchmarkNote}
        </p>
      </Section>

      <Section
        kicker="Math"
        title="Expectancy & break-even calculator"
        lede="Win rate alone is meaningless. This is the math that decides whether your reversal edge is real — and why unconfirmed reversals bleed accounts."
      >
        <ExpectancyCalculator />
      </Section>

      <Section
        kicker="Risk"
        title="Risk rules for scalps"
        lede="The rules the pros repeat — and the math that punishes ignoring them."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {riskRules.map((r) => (
            <div
              key={r.title}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
            >
              <h3 className="mb-1.5 font-semibold text-zinc-100">{r.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">{r.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        kicker="Validation"
        title="The 100-trade validation protocol"
        lede="How you make this empirically proven for yourself — instead of taking anyone's word for it."
      >
        <ol className="space-y-3">
          {validationProtocol.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-xs text-long">
                {i + 1}
              </span>
              <p className="text-sm leading-relaxed text-zinc-300">{step}</p>
            </li>
          ))}
        </ol>

        <Callout tone="info" title="WHY 100+ TRADES">
          At a 50–60% true win rate, 20–30 trades cannot distinguish your edge
          from noise (a 60% system will print 40% win-rate streaks over 30
          trades ~10% of the time). Log MFE/MAE durations too — they feed your
          time stops.
        </Callout>
      </Section>
    </>
  );
}
