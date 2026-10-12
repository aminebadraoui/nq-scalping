/* The shared study card — full inline content + strategy back-links.
 * Used by /studies (the full archive) and the stage tabs' Studies panes.
 * Server component: safe to render inside server pages. */

import { Suspense } from "react";
import Link from "next/link";
import { studies, CATEGORIES, bestConfigs, type StudyCategory } from "@/lib/studies";
import studyContent from "@/lib/studyContent.json";
import { strategiesForStudy } from "@/lib/strategies/registry";
import Markdown from "@/components/studies/Markdown";
import { LiveStudyPanel } from "@/components/studies/LiveStudyPanel";

export const CATEGORY_TONE: Record<StudyCategory, string> = {
  momentum: "text-emerald-300 border-emerald-900/60 bg-emerald-950/30",
  rth: "text-sky-300 border-sky-900/60 bg-sky-950/30",
  bias: "text-violet-300 border-violet-900/60 bg-violet-950/30",
  reversal: "text-zinc-400 border-zinc-700 bg-zinc-900/40",
  risk: "text-amber-300 border-amber-900/60 bg-amber-950/30",
  gates: "text-teal-300 border-teal-900/60 bg-teal-950/30",
  execution: "text-orange-300 border-orange-900/60 bg-orange-950/30",
  validation: "text-rose-300 border-rose-900/60 bg-rose-950/30",
  ops: "text-zinc-300 border-zinc-700 bg-zinc-900/60",
};

export function StudyCard({ study }: { study: (typeof studies)[number] }) {
  const content = (studyContent as Record<string, string>)[study.id] ?? "";
  const cat = CATEGORIES.find((c) => c.id === study.category);
  const linked = strategiesForStudy(study.id);
  const hasBest = bestConfigs.some((b) => b.studyId === study.id);
  return (
    <article id={`study-${study.id}`} data-search={`${study.id} ${study.title} ${study.question}`} className="contents scroll-mt-20">
      <details className="group rounded-lg border border-zinc-800 bg-zinc-900/30">
        <summary className="cursor-pointer list-none p-4 transition-colors hover:bg-zinc-900/40 [&::-webkit-details-marker]:hidden">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
            <span className="text-zinc-500">{study.date || "undated"}</span>
            <span className={`rounded border px-1.5 py-0.5 ${CATEGORY_TONE[study.category]}`}>{cat?.label ?? study.category}</span>
            {hasBest && (
              <Link
                href="/studies#best-configs"
                className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300"
                title="this study holds a verified best result — see best results at a glance"
              >
                ★ best
              </Link>
            )}
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
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">backtest</p>
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
        {/* the LIVE half streams in without blocking the backtest content */}
        <Suspense
          fallback={
            <div className="border-t border-zinc-800/60 bg-zinc-950/25 px-4 pb-4 pt-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-sky-300/70">live · loading…</p>
            </div>
          }
        >
          <LiveStudyPanel studyId={study.id} strategies={linked} />
        </Suspense>
      </details>
    </article>
  );
}
