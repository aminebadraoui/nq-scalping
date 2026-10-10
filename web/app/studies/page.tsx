import type { Metadata } from "next";
import Link from "next/link";
import { studies, byCategory, CATEGORIES, type StudyCategory } from "@/lib/studies";

export const metadata: Metadata = {
  title: "Studies",
  description:
    "Every backtest study in the archive: its question, the script that regenerates it, and the standard quality report (T1/T2/T4 + verdict) it prints.",
};

const CATEGORY_TONE: Record<StudyCategory, string> = {
  momentum: "text-emerald-300 border-emerald-900/60 bg-emerald-950/30",
  rth: "text-sky-300 border-sky-900/60 bg-sky-950/30",
  bias: "text-violet-300 border-violet-900/60 bg-violet-950/30",
  reversal: "text-zinc-400 border-zinc-700 bg-zinc-900/40",
  risk: "text-amber-300 border-amber-900/60 bg-amber-950/30",
  validation: "text-rose-300 border-rose-900/60 bg-rose-950/30",
  ops: "text-zinc-300 border-zinc-700 bg-zinc-900/60",
};

function StudyCard({ study }: { study: (typeof studies)[number] }) {
  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
        <span className="text-zinc-500">{study.date || "undated"}</span>
        <span className={`rounded border px-1.5 py-0.5 ${CATEGORY_TONE[study.category]}`}>
          {CATEGORIES.find((c) => c.id === study.category)?.label ?? study.category}
        </span>
        {study.engine && (
          <span className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300" title="script prints the === STANDARD REPORT === block (T1/T2/T4 + verdict)">
            standard ✓
          </span>
        )}
      </div>
      <h3 className="mt-2 text-sm font-semibold text-zinc-100">{study.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{study.question}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
        {study.script && (
          <span>
            script <code className="text-zinc-300">{study.script}</code>
          </span>
        )}
        <span>
          doc <code className="text-zinc-300">{study.doc}</code>
        </span>
      </div>
      {study.cli.length > 0 && (
        <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
          {study.cli.map((line, i) => (
            <div key={i}>
              <span className="select-none text-zinc-600">$ </span>
              {line}
            </div>
          ))}
        </pre>
      )}
    </article>
  );
}

export default function StudiesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-8">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">study archive</p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          Every study, one catalog
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">
          All {studies.length} studies in <code className="text-zinc-300">docs/research/</code>, grouped by family —
          each with the question it answers, the script that regenerates it, and the exact command. Scripts tagged{" "}
          <span className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">standard ✓</span>{" "}
          print the consolidated standard report on every run.
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

      {/* standard report reference */}
      <section className="mb-10 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
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
              <i>viability</i> question (can the account hit the profit target before the trailing floor?), not the edge question.
              Full contract: <code className="text-zinc-300">docs/BACKTEST-REPORT-STANDARD.md</code> · engine:{" "}
              <code className="text-zinc-300">web/lib/backtestEngine.ts</code> (789 passing tests).
            </p>
          </div>
        </div>
      </section>

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
          <section key={c.id} id={c.id} className="mb-10">
            <div className="mb-3 flex items-baseline gap-3 border-b border-zinc-800 pb-2">
              <h2 className="text-lg font-bold text-zinc-100">{c.label}</h2>
              <p className="text-[11px] text-zinc-500">{c.note}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((s) => (
                <StudyCard key={s.id} study={s} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-10 border-t border-zinc-800 pt-6 text-[11px] leading-relaxed text-zinc-600">
        Studies marked <span className="text-zinc-400">research-only</span> have no regenerating script (literature reviews,
        post-mortems, runbooks). Every trade-level script was migrated to the consolidated engine on 2026-10-10:
        scorers swapped only where semantics were provably identical, hand-rolled stats replaced by{" "}
        <code className="text-zinc-500">coreStats</code>/<code className="text-zinc-500">wilson95</code>, and the standard
        block appended — legacy output preserved above it. Educational research only — not financial advice.
      </p>
    </div>
  );
}
