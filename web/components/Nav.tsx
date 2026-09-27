"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/* Two surfaces only: the working dashboard and the documentation behind it. */
const links = [
  { href: "/", label: "Dashboard", note: "live working surface" },
  { href: "/docs", label: "Docs", note: "the research" },
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
    </header>
  );
}
