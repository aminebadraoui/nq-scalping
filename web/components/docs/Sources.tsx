import { Section, SourceRef } from "@/components/ui";
import { sourceGroups } from "@/lib/data";

export function SourcesSection() {
  return (
    <>
      <Section
        kicker="05 · Sources"
        title="Every source behind the playbook"
        lede="Grouped by evidence type. Vendor win-rate estimates are flagged as such in the pages that use them."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {sourceGroups.map((g) => (
            <div
              key={g.group}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5"
            >
              <h3 className="mb-3 font-mono text-sm font-semibold uppercase tracking-wider text-long">
                {g.group}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((s) => (
                  <SourceRef key={s.href} {...s} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
