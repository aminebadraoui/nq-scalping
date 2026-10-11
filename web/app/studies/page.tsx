import type { Metadata } from "next";
import Link from "next/link";
import { studies, byCategory, CATEGORIES, bestConfigs, type StudyCategory } from "@/lib/studies";
import studyContent from "@/lib/studyContent.json";
import { strategiesForStudy } from "@/lib/strategies/registry";
import Markdown from "@/components/studies/Markdown";
import StudiesSearch from "@/components/studies/StudiesSearch";

export const metadata: Metadata = {
  title: "Studies",
  description:
    "Every backtest study with its full content inline — question, method, results, honest bounds, and the standard quality report (T1/T2/T4 + verdict).",
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

// live-strategy linkage: the registry's reverse index maps a study id to
// the strategies it measured (lib/strategies/registry.ts) — data-driven,
// no hand-maintained map
const strategiesFor = (studyId: string) => strategiesForStudy(studyId);

function StudyCard({ study }: { study: (typeof studies)[number] }) {
  const content = (studyContent as Record<string, string>)[study.id] ?? "";
  const cat = CATEGORIES.find((c) => c.id === study.category);
  const linked = strategiesFor(study.id);
  return (
    <article id={`study-${study.id}`} data-search={`${study.id} ${study.title} ${study.question}`} className="contents scroll-mt-20">
      <details className="group rounded-lg border border-zinc-800 bg-zinc-900/30">
        <summary className="cursor-pointer list-none p-4 transition-colors hover:bg-zinc-900/40 [&::-webkit-details-marker]:hidden">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
            <span className="text-zinc-500">{study.date || "undated"}</span>
            <span className={`rounded border px-1.5 py-0.5 ${CATEGORY_TONE[study.category]}`}>{cat?.label ?? study.category}</span>
            {study.engine && (
              <span className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300" title="script prints the === STANDARD REPORT === block (T1/T2/T4 + verdict)">
                standard ✓
              </span>
            )}
            <span className="ml-auto text-zinc-600 transition-transform group-open:rotate-90">▸</span>
          </div>
          <h3 className="mt-2 text-sm font-semibold text-zinc-100">{study.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">{study.question}</p>
          {linked.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
              <span>live strategy →</span>
              {linked.map((s) => (
                <Link
                  key={s.id}
                  href={`/strategies#strategy-${s.id}`}
                  className="text-long hover:underline"
                  title={`${s.id} — open the live strategy card`}
                >
                  {s.id}
                </Link>
              ))}
            </div>
          )}
        </summary>
        <div className="border-t border-zinc-800/60 px-4 pb-4 pt-3">
          {content ? (
            <Markdown md={content} />
          ) : (
            <p className="text-xs leading-relaxed text-zinc-500">
              Script-only study — no doc written yet. Run the CLI below; every trade-level script prints the{" "}
              <code className="text-zinc-400">=== STANDARD REPORT ===</code> block (T1/T2/T4 + verdict) on each run.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
            {study.script && (
              <span>
                script <code className="text-zinc-300">{study.script}</code>
              </span>
            )}
            {study.doc && (
              <span>
                doc <code className="text-zinc-300">{study.doc}</code>
              </span>
            )}
          </div>
          {study.cli.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[10px] text-zinc-600 hover:text-zinc-400">regenerate (local CLI)</summary>
              <pre className="mt-1 overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                {study.cli.map((line, i) => (
                  <div key={i}>
                    <span className="select-none text-zinc-600">$ </span>
                    {line}
                  </div>
                ))}
              </pre>
            </details>
          )}
        </div>
      </details>
    </article>
  );
}

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
      <section className="mb-8 rounded-lg border border-emerald-900/60 bg-emerald-950/10 p-4">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-emerald-400">best configs at a glance</p>
        <p className="mb-3 text-[11px] text-zinc-500">
          The verified winners per study — picks, filter cells, and windows whose numbers come straight from the committed
          validation reports and the study docs. Click a study to jump to its card.
        </p>
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full border-collapse text-[11px] leading-relaxed">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-400">
                <th className="px-2 py-1.5 font-semibold">study</th>
                <th className="px-2 py-1.5 font-semibold">best config</th>
                <th className="px-2 py-1.5 text-right font-semibold">n</th>
                <th className="px-2 py-1.5 text-right font-semibold">WR</th>
                <th className="px-2 py-1.5 text-right font-semibold">PF</th>
                <th className="px-2 py-1.5 text-right font-semibold">exp pts</th>
                <th className="px-2 py-1.5 font-semibold">evidence</th>
              </tr>
            </thead>
            <tbody>
              {bestConfigs.map((b) => (
                <tr key={`${b.studyId}-${b.config}`} className="border-b border-zinc-800/50 align-top">
                  <td className="px-2 py-1.5">
                    <a href={`#study-${b.studyId}`} className="text-emerald-300 hover:underline">
                      {b.study}
                    </a>
                  </td>
                  <td className="px-2 py-1.5 text-zinc-300">{b.config}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{b.n?.toLocaleString() ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.wr !== null ? `${b.wr.toFixed(1)}%` : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.pf !== null ? b.pf.toFixed(2) : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.expPts !== null ? `+${b.expPts.toFixed(2)}` : "—"}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{b.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer font-mono text-[10px] text-zinc-500 hover:text-zinc-300">
            notation — what s0.35_t2.25_x60 means
          </summary>
          <div className="mt-2 grid gap-2 text-[11px] leading-relaxed text-zinc-400 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-zinc-200">STOP × TARGET × TIME grid coordinates</p>
              <ul className="list-inside list-disc space-y-1">
                <li><b className="text-zinc-300">s</b> — stop multiplier: the stop sits at <code className="text-zinc-300">s × R</code> from entry, where R is the signal&apos;s own designed risk (its natural stop distance). <code className="text-zinc-300">s0.35</code> = tighten the natural stop to 35% of it.</li>
                <li><b className="text-zinc-300">t</b> — target multiplier: the target sits at <code className="text-zinc-300">t × R</code>. <code className="text-zinc-300">t2.25</code> = target at 2.25× the signal&apos;s designed risk.</li>
                <li><b className="text-zinc-300">x</b> — time exit in minutes (1-min bars): neither stop nor target hit within x minutes → exit at the market. <code className="text-zinc-300">x60</code> = 60-minute cap.</li>
              </ul>
            </div>
            <div>
              <p className="mb-1 text-zinc-200">How to read the trade-off</p>
              <ul className="list-inside list-disc space-y-1">
                <li>Reward:risk = <b className="text-zinc-300">t ÷ s</b> — e.g. s0.35_t2.25 = <b className="text-zinc-300">6.4 : 1</b>.</li>
                <li>Smaller <b className="text-zinc-300">s</b> → tighter stop → lower win rate, cheaper losses.</li>
                <li>Larger <b className="text-zinc-300">t</b> → further target → lower win rate, bigger winners.</li>
                <li>Smaller <b className="text-zinc-300">x</b> → more time exits.</li>
                <li>The base grid config is <code className="text-zinc-300">s1.0_t1.0_x60</code> (1R / 1R / 60 min).</li>
              </ul>
              <p className="mt-1 text-zinc-500">
                Sweeps are points-level research input — the validated pick is the coordinate that survives DSR/PBO and the
                frozen holdout, not the argmax of one metric.
              </p>
            </div>
          </div>
        </details>
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
