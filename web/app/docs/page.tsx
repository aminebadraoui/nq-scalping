import type { Metadata } from "next";
import Link from "next/link";
import { OverviewSection } from "@/components/docs/Overview";
import { PlaybookSection } from "@/components/docs/Playbook";
import { LiveStrategiesSection } from "@/components/docs/LiveStrategies";
import { EvidenceSection } from "@/components/docs/Evidence";
import { ToolsSection } from "@/components/docs/Tools";
import { StrategiesSection } from "@/components/docs/Strategies";
import { ChecklistSection } from "@/components/docs/Checklist";
import { SourcesSection } from "@/components/docs/Sources";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "The full research behind the dashboard: evidence, tool stack, strategies, the confirmation checklist with the math, and every source.",
};

const TOC = [
  { id: "playbook", n: "00", label: "Our playbook", note: "how we trade it — the implemented strategy" },
  { id: "live-strategies", n: "01", label: "Live strategies", note: "every feed strategy, condition by condition + backtests" },
  { id: "overview", n: "02", label: "Overview", note: "the model, in one screen" },
  { id: "evidence", n: "03", label: "Evidence", note: "what the data actually says" },
  { id: "tools", n: "04", label: "Tool stack", note: "ranked, with each tool's tell" },
  { id: "strategies", n: "05", label: "Strategies studied", note: "the generic research plays" },
  { id: "checklist", n: "06", label: "Checklist & math", note: "desk tools + expectancy" },
  { id: "sources", n: "07", label: "Sources", note: "everything cited" },
];

export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-8">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">documentation</p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          Reversal vs fakeout — the whole research
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">
          Start with <strong className="text-zinc-200">Our playbook</strong> — the strategy the dashboard actually
          implements, condition by condition, with the panel that shows each one. The rest is the reference behind it:
          the evidence, the tool stack, the generic strategies we studied (including what we dropped), the pre-trade
          checklist with its math, and every source.
        </p>
        <p className="mt-3 font-mono text-[11px] text-zinc-500">
          working surface →{" "}
          <Link href="/" className="text-long hover:underline">
            the dashboard
          </Link>
        </p>
      </header>

      {/* table of contents */}
      <nav className="mb-10 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500">contents</p>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TOC.map((t) => (
            <li key={t.id}>
              <a
                href={`#${t.id}`}
                className="group flex items-baseline gap-2 rounded border border-zinc-800/70 px-3 py-2 transition-colors hover:border-long/50"
              >
                <span className="font-mono text-[10px] text-long">{t.n}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-zinc-200 group-hover:text-long">{t.label}</span>
                  <span className="block font-mono text-[10px] text-zinc-500">{t.note}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="space-y-16">
        <section id="playbook" className="scroll-mt-20">
          <PlaybookSection />
        </section>
        <section id="live-strategies" className="scroll-mt-20">
          <LiveStrategiesSection />
        </section>
        <section id="overview" className="scroll-mt-20">
          <OverviewSection />
        </section>
        <section id="evidence" className="scroll-mt-20">
          <EvidenceSection />
        </section>
        <section id="tools" className="scroll-mt-20">
          <ToolsSection />
        </section>
        <section id="strategies" className="scroll-mt-20">
          <StrategiesSection />
        </section>
        <section id="checklist" className="scroll-mt-20">
          <ChecklistSection />
        </section>
        <section id="sources" className="scroll-mt-20">
          <SourcesSection />
        </section>
      </div>

      <p className="mt-16 border-t border-zinc-800 pt-6 font-mono text-[11px] text-zinc-600">
        Educational research only — not financial advice. Live data, levels and alerts live on the{" "}
        <Link href="/" className="text-zinc-400 hover:text-zinc-200">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
