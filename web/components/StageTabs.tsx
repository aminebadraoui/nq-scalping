"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** the Live | Backtest | Studies switcher shared by the stage tabs
 *  (strategies / gates / execution / risk). */
export function StageTabs({ base }: { base: string }) {
  const pathname = usePathname();
  const modes = [
    { href: base, label: "Live" },
    { href: `${base}/backtest`, label: "Backtest" },
    { href: `${base}/studies`, label: "Studies" },
  ];
  return (
    <nav className="mb-6 flex flex-wrap gap-1 rounded-md border border-zinc-800 bg-zinc-900/40 p-1">
      {modes.map((m) => {
        const active = m.href === base ? pathname === base : pathname.startsWith(`${m.href}`);
        return (
          <Link
            key={m.href}
            href={m.href}
            className={`rounded px-3 py-1 font-mono text-xs transition-colors ${
              active ? "bg-zinc-800 text-long" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            {m.label}
          </Link>
        );
      })}
    </nav>
  );
}
