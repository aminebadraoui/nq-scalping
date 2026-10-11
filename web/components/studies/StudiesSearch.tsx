"use client";

import { useEffect, useState } from "react";

/** Instant search over the study cards. Filters by toggling the `hidden`
 *  attribute on the server-rendered articles (reads data-search attrs) —
 *  the full study bodies stay server-side, nothing heavy ships to the client. */
export default function StudiesSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("article[data-search]"));
    const query = q.trim().toLowerCase();
    for (const c of cards) {
      // full-text: title + question + rendered body all live in the DOM
      c.hidden = query !== "" && !c.textContent?.toLowerCase().includes(query);
    }
    const visible = cards.filter((c) => !c.hidden).length;
    document.getElementById("studies-count")!.textContent = query ? `${visible} matching` : `${cards.length} total`;
  }, [q]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search questions, titles, results…"
        className="w-72 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-800"
      />
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          const details = Array.from(document.querySelectorAll<HTMLDetailsElement>("article[data-search] details"));
          for (const d of details) {
            if (next) d.open = true;
            else d.removeAttribute("open");
          }
        }}
        className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        {open ? "collapse all" : "expand all"}
      </button>
    </div>
  );
}
