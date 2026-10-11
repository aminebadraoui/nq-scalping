import Link from "next/link";
import { byCategory, type StudyCategory } from "@/lib/studies";
import { StudyCard } from "@/components/studies/StudyCard";

/** one stage's Studies pane: the study catalog filtered by category.
 *  compact mode (Backtest panes) shows a lightweight run-card instead of
 *  the full inline content. */
export function StudyPane({ categories, compact = false }: { categories: StudyCategory[]; compact?: boolean }) {
  const list = categories.flatMap((c) => byCategory(c)).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (compact) {
    return (
      <div className="grid items-start gap-3 md:grid-cols-2">
        {list.map((s) => (
          <article key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
            <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
              <span>{s.date || "undated"}</span>
              {s.engine && (
                <span className="rounded border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-300" title="prints the === STANDARD REPORT === block">
                  standard ✓
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold text-zinc-100">{s.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{s.question}</p>
            {s.cli.length > 0 && (
              <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                {s.cli.map((line, i) => (
                  <div key={i}>
                    <span className="select-none text-zinc-600">$ </span>
                    {line}
                  </div>
                ))}
              </pre>
            )}
            <p className="mt-2 font-mono text-[10px] text-zinc-600">
              full content →{" "}
              <Link href={`/studies#study-${s.id}`} className="text-long hover:underline">
                study card
              </Link>
            </p>
          </article>
        ))}
        {list.length === 0 && (
          <p className="font-mono text-xs text-zinc-600">no studies in this category yet.</p>
        )}
      </div>
    );
  }
  return (
    <div className="grid items-start gap-3 md:grid-cols-2">
      {list.map((s) => (
        <StudyCard key={s.id} study={s} />
      ))}
    </div>
  );
}
