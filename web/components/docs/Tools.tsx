import { Callout, Section } from "@/components/ui";
import { toolSkips, toolTiers } from "@/lib/data";

const tierTone = {
  "Tier 1": "border-long/40 text-long",
  "Tier 2": "border-info/40 text-info",
  "Tier 3": "border-warn/40 text-warn",
} as const;

export function ToolsSection() {
  return (
    <>
      <Section
        kicker="02 · Tools"
        title="The tool stack, ranked by evidence"
        lede="Tier 1 tools measure the documented predictive variable (order flow). Tier 2 defines where reversals are allowed to happen. Tier 3 is confluence only — weak alone."
      />

      {toolTiers.map((tier) => (
        <section key={tier.tier} className="mb-12">
          <div className="mb-4 flex items-baseline gap-3">
            <span
              className={`rounded border px-2.5 py-0.5 font-mono text-sm font-semibold ${
                tierTone[tier.tier as keyof typeof tierTone]
              }`}
            >
              {tier.tier}
            </span>
            <span className="text-sm text-zinc-500">{tier.tag}</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {tier.tools.map((t) => (
              <div
                key={t.name}
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5"
              >
                <h3 className="mb-3 font-semibold text-zinc-100">{t.name}</h3>
                <p className="mb-3 text-sm leading-relaxed text-zinc-500">
                  {t.what}
                </p>
                <div className="space-y-3">
                  <div className="rounded-md border border-long/20 bg-long/5 p-3">
                    <p className="mb-1 font-mono text-xs uppercase tracking-wider text-long">
                      Reversal tell
                    </p>
                    <p className="text-sm leading-relaxed text-zinc-300">
                      {t.reversalTell}
                    </p>
                  </div>
                  <div className="rounded-md border border-short/20 bg-short/5 p-3">
                    <p className="mb-1 font-mono text-xs uppercase tracking-wider text-short">
                      Fakeout tell
                    </p>
                    <p className="text-sm leading-relaxed text-zinc-300">
                      {t.fakeoutTell}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <Section kicker="Skip" title="Treat with suspicion" lede="">
        <ul className="space-y-2">
          {toolSkips.map((s, i) => (
            <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-300">
              <span className="mt-0.5 font-mono text-xs text-short">✕</span>
              {s}
            </li>
          ))}
        </ul>

        <Callout tone="long" title="THE PROFESSIONAL 3-LAYER CONFIRMATION">
          &ldquo;Volume profile, session levels, delta divergence — any one is
          interesting; all three aligning means a trap is likely forming —
          and that&rsquo;s a cue to <em>prepare</em>, not to enter.&rdquo; Entry
          still waits for the close-based reclaim.
        </Callout>
      </Section>
    </>
  );
}
