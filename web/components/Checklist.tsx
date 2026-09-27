"use client";

import { useEffect, useState } from "react";
import { checklistItems } from "@/lib/data";

const STORAGE_KEY = "scalping-checklist-v1";

export default function Checklist() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setChecked(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
    } catch {
      /* ignore */
    }
  }, [checked, loaded]);

  const done = checklistItems.filter((i) => checked[i.id]).length;
  const pct = Math.round((done / checklistItems.length) * 100);

  const toggle = (id: string) =>
    setChecked((c) => ({ ...c, [id]: !c[id] }));

  const reset = () => setChecked({});

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="mb-1 flex items-baseline justify-between">
            <p className="font-mono text-sm text-zinc-400">
              {done}/{checklistItems.length} confirmed
            </p>
            <p className="font-mono text-sm font-semibold text-long">{pct}%</p>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full rounded bg-long transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <button
          onClick={reset}
          className="rounded-md border border-zinc-700 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:border-short hover:text-short"
        >
          Reset
        </button>
      </div>

      <ul className="space-y-1">
        {checklistItems.map((item) => {
          const on = !!checked[item.id];
          return (
            <li key={item.id}>
              <button
                onClick={() => toggle(item.id)}
                className="flex w-full items-start gap-3 rounded-md p-2 text-left transition-colors hover:bg-zinc-800/50"
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                    on
                      ? "border-long bg-long/15 text-long"
                      : "border-zinc-600 text-transparent"
                  }`}
                  aria-hidden
                >
                  ✓
                </span>
                <span>
                  <span
                    className={`font-medium ${
                      on ? "text-zinc-100" : "text-zinc-300"
                    }`}
                  >
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-zinc-500">
                    {item.detail}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
        Progress is saved in your browser (localStorage) — reset at the start of
        each session.
      </p>
    </div>
  );
}
