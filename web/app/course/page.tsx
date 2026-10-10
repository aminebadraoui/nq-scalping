import type { Metadata } from "next";
import Link from "next/link";
import { FoundationsSection } from "@/components/course/Foundations";
import { MomentumModule } from "@/components/course/MomentumModule";
import { RthModule, OpenModule } from "@/components/course/RthOpenModule";
import { InputsGatesSection } from "@/components/course/InputsGates";
import { ExecutionModule, RiskModule } from "@/components/course/ExecutionRisk";
import { ChipsModule, CheatSheetsModule } from "@/components/course/ChipsCheatSheets";

export const metadata: Metadata = {
  title: "Course",
  description:
    "The manual trader's course: our NQ scalping system taught from zero — the strategies, the journal's input and gate features, execution, and the risk plan.",
};

const TOC = [
  { id: "intro", n: "00", label: "The big picture", note: "what you are learning and why it works" },
  { id: "foundations", n: "01", label: "Foundations", note: "the vocabulary — bars, delta, ATR, clusters, sessions" },
  { id: "momentum", n: "02", label: "The Momentum card", note: "failed-flush breakout + huge-bar expansion, gate by gate" },
  { id: "rth", n: "03", label: "The RTH card", note: "the daytime footprint-proven continuation" },
  { id: "open", n: "04", label: "The Open family", note: "drive, pullback and sniper for the first hour" },
  { id: "codebook", n: "05", label: "Inputs & gates codebook", note: "every journal variable decoded, strategy by strategy" },
  { id: "execution", n: "06", label: "Execution", note: "the nine-step trade and the sizing formula" },
  { id: "risk", n: "07", label: "Risk management", note: "the account, the day plan, the measured balance" },
  { id: "chips", n: "08", label: "Context chips", note: "the study-only labels — never gates" },
  { id: "cheatsheets", n: "09", label: "Cheat sheets", note: "the whole course on one screen" },
];

export default function CoursePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-8">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">
          course · learn the system bar by bar
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          The Manual Trader&rsquo;s Course
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">
          Everything you need to trade our NQ scalping system by hand — the strategies and their exact
          conditions, every <strong className="text-zinc-200">input and gate</strong> the Journal records and
          how each strategy uses them, the execution procedure, and the risk plan that keeps the account alive.
          Written for a beginner: each module builds on the last, and module 05 answers the question this course
          was built around.
        </p>
        <p className="mt-3 font-mono text-[11px] text-zinc-500">
          the machine&rsquo;s version of the same checks →{" "}
          <Link href="/strategies" className="text-long hover:underline">
            the strategies page
          </Link>
          {" · "}
          where the trades get recorded →{" "}
          <Link href="/journal" className="text-long hover:underline">
            the journal
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
                  <span className="block text-sm font-semibold text-zinc-200 group-hover:text-long">
                    {t.label}
                  </span>
                  <span className="block font-mono text-[10px] text-zinc-500">{t.note}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* the modules */}
      <div className="space-y-4">
        <FoundationsSection />
        <MomentumModule />
        <RthModule />
        <OpenModule />
        <InputsGatesSection />
        <ExecutionModule />
        <RiskModule />
        <ChipsModule />
        <CheatSheetsModule />
      </div>

      <p className="mt-16 border-t border-zinc-800 pt-6 font-mono text-[11px] text-zinc-600">
        Educational research only — not financial advice. The same system, condition by condition, is on the{" "}
        <Link href="/strategies" className="text-zinc-400 hover:text-zinc-200">
          strategies page
        </Link>
        ; the research and sources behind every number are on the{" "}
        <Link href="/docs" className="text-zinc-400 hover:text-zinc-200">
          docs page
        </Link>
        .
      </p>
    </div>
  );
}
