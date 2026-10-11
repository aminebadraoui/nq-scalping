import type { Metadata } from "next";
import Link from "next/link";
import { studies, byCategory, CATEGORIES } from "@/lib/studies";
import { StudyCard } from "@/components/studies/StudyCard";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";
import StudiesSearch from "@/components/studies/StudiesSearch";

export const metadata: Metadata = {
  title: "Studies",
  description:
    "Every backtest study with its full content inline — question, method, results, honest bounds, and the standard quality report (T1/T2/T4 + verdict).",
};

export default function StudiesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-8">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">study archive</p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          Every study, full content inline
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">
          All {studies.length} studies with their complete content — question, method, result tables, what was
          falsified, honest bounds — rendered right here from the committed archive{" "}
          <code className="text-zinc-300">lib/studyContent.json</code>. Expand any card; search filters instantly.
        </p>
        <p className="mt-3 font-mono text-[11px] text-zinc-500">
          working surface →{" "}
          <Link href="/" className="text-long hover:underline">
            the dashboard
          </Link>{" "}
          · sweep page →{" "}
          <Link href="/backtest" className="text-long hover:underline">
            /backtest
          </Link>
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <StudiesSearch />
        <span id="studies-count" className="font-mono text-[11px] text-zinc-500">
          {studies.length} total
        </span>
      </div>

      {/* standard report reference */}
      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500">the standard report</p>
        <div className="grid gap-4 text-xs leading-relaxed text-zinc-400 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-zinc-200">Four tables + one verdict, identical in every study:</p>
            <ul className="list-inside list-disc space-y-1">
              <li><b className="text-zinc-300">T0</b> study card — instrument, sample, cost, fill, exit, split, significance</li>
              <li><b className="text-zinc-300">T1</b> core quality — n · WR [Wilson CI] · avg win/loss · payoff · exp pts/R · PF · SQN · maxDD · session Sharpe · concentration, for all/train/test</li>
              <li><b className="text-zinc-300">T2</b> segments — one row per rule/cell, n first, opposite side last</li>
              <li><b className="text-zinc-300">T3</b> sweep audit — DSR / PBO / PSR / MinTRL / frozen holdout (grids only)</li>
              <li><b className="text-zinc-300">T4</b> prop viability — eval/funded sims + P(pass before breach) bootstrap + maxDD vs MLL</li>
            </ul>
          </div>
          <div>
            <p className="mb-1 text-zinc-200">The five-slot verdict:</p>
            <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] text-emerald-300">
{`VERDICT: edge real · significance PASS (PSR 0.97)
 · stability stable · holdout PASS · viability PASS (P=0.93)`}
            </pre>
            <p className="mt-2">
              Edge = positive expectancy per unit risk, net of costs, out-of-sample, significant, stable. Max drawdown is the{" "}
              <i>viability</i> question (can the account hit the profit target before the trailing floor?), not the edge
              question. The full contract is the <b className="text-zinc-300">Consolidated backtest engine + report standard</b>{" "}
              card under <a href="#validation" className="text-long underline decoration-zinc-700 underline-offset-2">validation</a>.
            </p>
          </div>
        </div>
      </section>

      {/* best configs at a glance */}
      <BestConfigsTable />

      {/* contents */}
      <nav className="mb-8 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => {
          const n = byCategory(c.id).length;
          if (!n) return null;
          return (
            <a key={c.id} href={`#${c.id}`} className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:text-zinc-200">
              {c.label} <span className="text-zinc-600">({n})</span>
            </a>
          );
        })}
      </nav>

      {/* sections */}
      {CATEGORIES.map((c) => {
        const list = byCategory(c.id);
        if (!list.length) return null;
        return (
          <section key={c.id} id={c.id} className="mb-10 scroll-mt-20">
            <div className="mb-3 flex items-baseline gap-3 border-b border-zinc-800 pb-2">
              <h2 className="text-lg font-bold text-zinc-100">{c.label}</h2>
              <p className="text-[11px] text-zinc-500">{c.note}</p>
            </div>
            <div className="grid items-start gap-3 md:grid-cols-2">
              {list.map((s) => (
                <StudyCard key={s.id} study={s} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-10 border-t border-zinc-800 pt-6 text-[11px] leading-relaxed text-zinc-600">
        Content is embedded from the committed study archive (docs/research at build time). Every trade-level script was
        migrated to the consolidated engine on 2026-10-10: scorers swapped only where semantics were provably identical,
        hand-rolled stats replaced by <code className="text-zinc-500">coreStats</code>/
        <code className="text-zinc-500">wilson95</code>, and the standard block appended. Educational research only — not
        financial advice.
      </p>
    </div>
  );
}
