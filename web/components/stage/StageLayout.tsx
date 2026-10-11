import type { ReactNode } from "react";
import { StageTabs } from "@/components/StageTabs";

/** shared stage-tab page chrome: header + Live|Backtest|Studies switcher. */
export function StageLayout({
  base,
  kicker,
  title,
  intro,
  children,
}: {
  base: string;
  kicker: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-6">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">{kicker}</p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">{intro}</p>
      </header>
      <StageTabs base={base} />
      {children}
    </div>
  );
}
