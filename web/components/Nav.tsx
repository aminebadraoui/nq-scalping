"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/* Surfaces, organized by STAGE (what the system does) with a
 * Live | Backtest | Studies mode inside each stage tab:
 *   Overview — the working dashboard, everything live at a glance
 *   Macro — market context: every macro box + its guides and AI reads
 *   Strategies — what we trade (registry, sweeps, studies)
 *   Gates — the regime a strategy may execute in (windows, vetoes, filters)
 *   Execution — orders, fills, the executor's records
 *   Risk — account protection + sizing (one rule set, every stage)
 *   Journal — the loop: trades, insights, overrides
 *   Docs — the research narrative + course */
const links = [
  { href: "/", label: "Overview", note: "live working surface", stage: null },
  { href: "/macro", label: "Macro", note: "market context — guides + AI interpretations", stage: null },
  { href: "/strategies", label: "Strategies", note: "what we trade — live, backtest, studies", stage: true },
  { href: "/gates", label: "Gates", note: "the regime a strategy can execute in", stage: true },
  { href: "/promotions", label: "Promotions", note: "what passed / failed the promotion contract", stage: null },
  { href: "/review", label: "Review", note: "the weekly self-improvement loop", stage: null },
  { href: "/execution", label: "Execution", note: "orders, fills, the executor", stage: true },
  { href: "/tvmd", label: "Feeds", note: "GoCharting vs Tradovate — live comparison + signal-time audit", stage: null },
  { href: "/risk", label: "Risk", note: "account protection + sizing", stage: true },
  { href: "/journal", label: "Journal", note: "trades, win/loss analysis, AI review", stage: null },
  { href: "/docs", label: "Docs", note: "the research", stage: null },
];

const docAnchors = [
  { href: "/docs#evidence", label: "Evidence" },
  { href: "/docs#tools", label: "Tools" },
  { href: "/docs#strategies", label: "Strategies" },
  { href: "/docs#checklist", label: "Checklist" },
  { href: "/docs#sources", label: "Sources" },
];

export default function Nav() {
  const pathname = usePathname();
  const onDocs = pathname.startsWith("/docs");
  const stage = links.find((l) => l.stage && pathname.startsWith(l.href));
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1800px] items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-long shadow-[0_0_10px_rgba(52,211,153,0.8)]" />
          <span className="font-mono text-sm font-semibold tracking-widest text-zinc-100">
            SCALPING&nbsp;PLAYBOOK
          </span>
        </Link>

        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                title={l.note}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono transition-colors ${
                  active ? "bg-zinc-800 text-long" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                {l.label}
              </Link>
            );
          })}

          {/* anchor shortcuts — only while reading the docs */}
          <span className={`ml-2 items-center gap-1 ${onDocs ? "hidden lg:flex" : "hidden"}`}>
            {docAnchors.map((a) => (
              <a
                key={a.href}
                href={a.href}
                className="whitespace-nowrap rounded-md px-2 py-1.5 font-mono text-[11px] text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
              >
                {a.label}
              </a>
            ))}
          </span>
        </nav>
      </div>

      {/* stage sub-tabs: Live | Backtest | Studies */}
      {stage && (
        <div className="border-t border-zinc-800/60 bg-zinc-950/60">
          <div className="mx-auto flex w-full max-w-[1800px] items-center gap-1 px-4 py-1.5">
            {[
              { href: stage.href, label: "Live" },
              { href: `${stage.href}/backtest`, label: "Backtest" },
              { href: `${stage.href}/studies`, label: "Studies" },
            ].map((m) => {
              const active = m.href === stage.href ? pathname === stage.href : pathname.startsWith(m.href);
              return (
                <Link
                  key={m.href}
                  href={m.href}
                  className={`rounded px-2.5 py-0.5 font-mono text-[11px] transition-colors ${
                    active ? "bg-zinc-800 text-long" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
                  }`}
                >
                  {m.label}
                </Link>
              );
            })}
            <span className="ml-auto hidden font-mono text-[10px] text-zinc-600 lg:block">{stage.note}</span>
          </div>
        </div>
      )}
    </header>
  );
}
