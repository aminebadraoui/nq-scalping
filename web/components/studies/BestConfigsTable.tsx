import Link from "next/link";
import { bestConfigs } from "@/lib/studies";
import { strategiesForStudy } from "@/lib/strategies/registry";

/* The verified winners, everywhere. One table fed by lib/studies.ts
 * bestConfigs (numbers read directly from the committed validation
 * reports and study docs), with live-strategy chips and the s/t/x
 * legend. Used by /studies (full table) and by every stage tab's
 * Backtest + Studies panes (filtered). Renders an honest empty state
 * where a stage has no verified rows yet. */

export function BestConfigsTable({
  studyIds,
  title = "best results at a glance",
  compact = false,
}: {
  /** filter to these study ids; undefined = all rows */
  studyIds?: string[];
  title?: string;
  compact?: boolean;
}) {
  const rows = bestConfigs.filter((b) => !studyIds || studyIds.includes(b.studyId));

  if (rows.length === 0) {
    return (
      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{title}</p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          No verified best-result rows recorded for this stage yet — the full table lives on the{" "}
          <Link href="/studies#best-configs" className="text-long hover:underline">
            studies page
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section id={compact ? undefined : "best-configs"} className="mb-8 scroll-mt-24 rounded-lg border border-emerald-900/60 bg-emerald-950/10 p-4">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-emerald-400">{title}</p>
      <p className="mb-3 text-[11px] text-zinc-500">
        The verified winners — picks, filter cells, and windows whose numbers come straight from the committed validation
        reports and the study docs. Click a study to jump to its full card.
      </p>
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-[11px] leading-relaxed">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="px-2 py-1.5 font-semibold">study</th>
              <th className="px-2 py-1.5 font-semibold">best config</th>
              <th className="px-2 py-1.5 font-semibold">strategy</th>
              <th className="px-2 py-1.5 text-right font-semibold">n</th>
              <th className="px-2 py-1.5 text-right font-semibold">WR</th>
              <th className="px-2 py-1.5 text-right font-semibold">PF</th>
              <th className="px-2 py-1.5 text-right font-semibold">exp pts</th>
              <th className="px-2 py-1.5 font-semibold">evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const linked = strategiesForStudy(b.studyId);
              return (
                <tr key={`${b.studyId}-${b.config}`} className="border-b border-zinc-800/50 align-top">
                  <td className="px-2 py-1.5">
                    <Link href={`/studies#study-${b.studyId}`} className="text-emerald-300 hover:underline">
                      {b.study}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-zinc-300">{b.config}</td>
                  <td className="px-2 py-1.5">
                    {linked.length > 0 ? (
                      <span className="flex flex-wrap gap-1 font-mono text-[10px]">
                        {linked.map((s) => (
                          <Link key={s.id} href={`/strategies#strategy-${s.id}`} className="text-long hover:underline">
                            {s.id}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{b.n?.toLocaleString() ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.wr !== null ? `${b.wr.toFixed(1)}%` : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.pf !== null ? b.pf.toFixed(2) : "—"}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-300">{b.expPts !== null ? `+${b.expPts.toFixed(2)}` : "—"}</td>
                  <td className="px-2 py-1.5 text-zinc-500">{b.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {compact ? (
        <p className="mt-3 font-mono text-[10px] text-zinc-500">
          s/t/x notation (stop × target × time) explained on the{" "}
          <Link href="/studies#best-configs" className="text-long hover:underline">
            studies page
          </Link>
          .
        </p>
      ) : (
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
      )}
    </section>
  );
}
