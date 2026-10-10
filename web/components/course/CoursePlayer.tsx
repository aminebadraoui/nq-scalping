"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CURRICULUM,
  FLAT_LESSONS,
  TOTAL_LESSONS,
  TOTAL_MINUTES,
  lessonById,
  type CourseModule,
} from "./curriculum";

/* ------------------------------------------------------------------ *
 * CoursePlayer — the sidebar-style course shell.
 *
 * Left: the curriculum (modules → lessons) with per-lesson status and
 * per-module completion. Right: the current lesson with prev/next and
 * mark-complete. Progress persists in localStorage; lesson ids are
 * deep-link anchors (/course#id); ArrowLeft/Right navigate; the last
 * visited lesson resumes on the next visit.
 * ------------------------------------------------------------------ */

const COMPLETED_KEY = "nq-course-completed-v1";
const LAST_KEY = "nq-course-last-v1";

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function loadLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/* apply after hydration but BEFORE first paint — no flash of lesson 1 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function lessonStatus(
  completed: Set<string>,
  current: string,
  id: string,
): "done" | "current" | "todo" {
  if (completed.has(id)) return "done";
  if (id === current) return "current";
  return "todo";
}

/* ------------------------------------------------ the sidebar nav */

function CurriculumNav({
  completed,
  current,
  onSelect,
  collapsed,
  onToggleModule,
  compact = false,
}: {
  completed: Set<string>;
  current: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggleModule: (id: string) => void;
  compact?: boolean;
}) {
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  useEffect(() => {
    rowRefs.current.get(current)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className={compact ? "" : "py-1"}>
      {CURRICULUM.map((m: CourseModule, mi: number) => {
        const done = m.lessons.filter((l) => completed.has(l.id)).length;
        const total = m.lessons.length;
        const isOpen = !collapsed.has(m.id);
        const moduleDone = done === total && total > 0;
        return (
          <div key={m.id} className="border-b border-zinc-800/60 last:border-0">
            <button
              onClick={() => onToggleModule(m.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-900"
            >
              <span className="font-mono text-[10px] text-zinc-600">{isOpen ? "▾" : "▸"}</span>
              <span className="text-sm">{m.emoji}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold uppercase tracking-wider text-zinc-300">
                {m.title}
              </span>
              <span
                className={`font-mono text-[10px] ${moduleDone ? "text-long" : done > 0 ? "text-info" : "text-zinc-600"}`}
              >
                {done}/{total}
              </span>
            </button>
            {isOpen && (
              <ul className="pb-1">
                {m.lessons.map((l, li) => {
                  const st = lessonStatus(completed, current, l.id);
                  return (
                    <li key={l.id}>
                      <button
                        ref={(el) => {
                          rowRefs.current.set(l.id, el);
                        }}
                        onClick={() => onSelect(l.id)}
                        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                          st === "current"
                            ? "border-l-2 border-long bg-zinc-800/70 text-zinc-100"
                            : "border-l-2 border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                        }`}
                      >
                        <span
                          className={`w-4 shrink-0 text-center font-mono text-[10px] ${
                            st === "done" ? "text-long" : st === "current" ? "text-long" : "text-zinc-600"
                          }`}
                        >
                          {st === "done" ? "✓" : st === "current" ? "▶" : "○"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-mono text-[10px] text-zinc-600">{mi + 1}.{li + 1}</span>{" "}
                          <span
                            className={`text-[12px] leading-snug ${
                              st === "current" ? "font-semibold" : st === "done" ? "text-zinc-300" : ""
                            }`}
                          >
                            {l.title}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[9px] text-zinc-600">{l.minutes}m</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------ the player */

export function CoursePlayer() {
  const [current, setCurrent] = useState<string>(FLAT_LESSONS[0].id);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [curriculumOpen, setCurriculumOpen] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);

  const lesson = lessonById(current) ?? FLAT_LESSONS[0];
  const flatIdx = FLAT_LESSONS.findIndex((l) => l.id === lesson.id);
  const prev = flatIdx > 0 ? FLAT_LESSONS[flatIdx - 1] : null;
  const next = flatIdx < FLAT_LESSONS.length - 1 ? FLAT_LESSONS[flatIdx + 1] : null;

  const doneCount = useMemo(() => FLAT_LESSONS.filter((l) => completed.has(l.id)).length, [completed]);
  const pct = TOTAL_LESSONS > 0 ? Math.round((doneCount / TOTAL_LESSONS) * 100) : 0;
  const allDone = doneCount === TOTAL_LESSONS;

  const selectLesson = useCallback((id: string) => {
    setCurrent(id);
    try {
      localStorage.setItem(LAST_KEY, id);
      history.replaceState(null, "", `#${id}`);
    } catch {
      /* storage/history unavailable — navigation still works in-memory */
    }
  }, []);

  /* hydrate state once, before paint */
  useIsomorphicLayoutEffect(() => {
    setCompleted(loadSet(COMPLETED_KEY));
    const hash = window.location.hash.slice(1);
    const fromHash = hash && lessonById(hash);
    const last = loadLast();
    const fromLast = last && lessonById(last);
    if (fromHash) setCurrent(fromHash.id);
    else if (fromLast) setCurrent(fromLast.id);
  }, []);

  /* persist completion */
  useEffect(() => {
    try {
      localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completed]));
    } catch {
      /* ignore */
    }
  }, [completed]);

  /* external hash edits (e.g. in-lesson anchors) switch lessons */
  useEffect(() => {
    const onHash = () => {
      const id = window.location.hash.slice(1);
      if (id && lessonById(id)) setCurrent(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* scroll the article to the top on lesson change */
  useEffect(() => {
    articleRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [current]);

  /* keyboard: ← / → navigate */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" && next) {
        e.preventDefault();
        selectLesson(next.id);
      } else if (e.key === "ArrowLeft" && prev) {
        e.preventDefault();
        selectLesson(prev.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, selectLesson]);

  const toggleComplete = useCallback(() => {
    setCompleted((prevSet) => {
      const s = new Set(prevSet);
      if (s.has(lesson.id)) s.delete(lesson.id);
      else s.add(lesson.id);
      return s;
    });
  }, [lesson.id]);

  const toggleModule = useCallback((id: string) => {
    setCollapsed((prevSet) => {
      const s = new Set(prevSet);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }, []);

  const resetProgress = useCallback(() => {
    if (!window.confirm("Reset all course progress and start over?")) return;
    try {
      localStorage.removeItem(COMPLETED_KEY);
      localStorage.removeItem(LAST_KEY);
    } catch {
      /* ignore */
    }
    setCompleted(new Set());
    setCurrent(FLAT_LESSONS[0].id);
  }, []);

  const isDone = completed.has(lesson.id);
  const { Content } = lesson;
  const navProps = { completed, current, onSelect: selectLesson, collapsed, onToggleModule: toggleModule };

  return (
    <div>
      {/* ------------------------------------------------ hero + progress */}
      <header className="mb-6">
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.25em] text-long">
          course · learn the system bar by bar
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
          The Manual Trader&rsquo;s Course
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Everything you need to trade our NQ scalping system by hand — the strategies and their exact
          conditions, every input and gate the Journal records, the execution procedure, and the risk plan.
          Work through it like a course platform: mark lessons complete, track your progress, and pick up
          where you left off.
        </p>

        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              {allDone ? "course complete — every lesson done" : "course progress"}
            </span>
            <span className="font-mono text-xs text-zinc-300">
              {allDone && <span className="mr-2">🎉</span>}
              {doneCount}/{TOTAL_LESSONS} lessons · {pct}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                allDone ? "bg-long" : "bg-long/80"
              }`}
              style={{ width: `${pct}%`, boxShadow: "0 0 10px rgba(52,211,153,0.5)" }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-zinc-600">
            <span>
              {TOTAL_LESSONS} lessons · ~{Math.round(TOTAL_MINUTES / 5) * 5} min read · progress saved on this
              device
            </span>
            {doneCount > 0 && (
              <button
                onClick={resetProgress}
                className="text-zinc-600 underline-offset-2 transition-colors hover:text-zinc-400 hover:underline"
              >
                reset progress
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ------------------------------------------------ mobile curriculum toggle */}
      <div className="mb-4 lg:hidden">
        <button
          onClick={() => setCurriculumOpen((o) => !o)}
          className="flex w-full items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-left transition-colors hover:border-zinc-700"
        >
          <span className="font-mono text-xs text-zinc-300">
            📚 Curriculum — {lesson.module.emoji} {lesson.module.title} · lesson {lesson.lessonIdx + 1} of{" "}
            {lesson.module.lessons.length}
          </span>
          <span className="font-mono text-xs text-zinc-500">{curriculumOpen ? "▴" : "▾"}</span>
        </button>
        {curriculumOpen && (
          <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40">
            <CurriculumNav {...navProps} compact />
          </div>
        )}
      </div>

      {/* ------------------------------------------------ two-pane layout */}
      <div className="flex items-start gap-6">
        {/* sidebar */}
        <aside className="hidden w-80 shrink-0 lg:block">
          <div className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">curriculum</span>
              <span className="font-mono text-[10px] text-zinc-600">
                {doneCount}/{TOTAL_LESSONS}
              </span>
            </div>
            <div className="max-h-[calc(100vh-11.5rem)] overflow-y-auto">
              <CurriculumNav {...navProps} />
            </div>
            <div className="border-t border-zinc-800 px-3 py-2">
              <button
                onClick={resetProgress}
                className="font-mono text-[10px] text-zinc-600 transition-colors hover:text-zinc-400"
              >
                ↺ reset progress
              </button>
            </div>
          </div>
        </aside>

        {/* lesson pane */}
        <main className="min-w-0 flex-1">
          <article ref={articleRef} className="scroll-mt-20 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
            <header className="border-b border-zinc-800 p-5">
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-long">
                module {lesson.moduleIdx + 1} · lesson {lesson.lessonIdx + 1} of {lesson.module.lessons.length} ·{" "}
                {lesson.module.emoji} {lesson.module.title}
              </p>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="text-xl font-bold tracking-tight text-zinc-50 sm:text-2xl">{lesson.title}</h2>
                <span
                  className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] ${
                    isDone
                      ? "border-long/50 bg-long/10 text-long"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-500"
                  }`}
                >
                  {isDone ? "completed ✓" : "not complete yet"}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[10px] text-zinc-600">
                {lesson.minutes} min read · use ← → to move between lessons
              </p>
            </header>

            <div className="p-5 sm:p-6">
              <Content />
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 p-4">
              <button
                onClick={() => prev && selectLesson(prev.id)}
                disabled={!prev}
                className="max-w-[45%] rounded-md border border-zinc-800 px-3 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="block font-mono text-[9px] uppercase tracking-wider text-zinc-500">← previous</span>
                {prev && <span className="block truncate text-xs text-zinc-300">{prev.title}</span>}
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={toggleComplete}
                  className={`rounded-md border px-3 py-2 font-mono text-xs transition-colors ${
                    isDone
                      ? "border-long/50 bg-long/10 text-long hover:bg-long/20"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-long/50 hover:text-long"
                  }`}
                >
                  {isDone ? "✓ completed (undo)" : "✓ mark complete"}
                </button>
                <button
                  onClick={() => next && selectLesson(next.id)}
                  disabled={!next}
                  className={`max-w-[45%] rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    next
                      ? "border-long/40 bg-long/10 text-long hover:bg-long/20"
                      : "border-zinc-800 text-zinc-600"
                  }`}
                >
                  <span className="block font-mono text-[9px] uppercase tracking-wider opacity-80">next →</span>
                  {next ? (
                    <span className="block truncate text-xs">{next.title}</span>
                  ) : (
                    <span className="block text-xs">course complete 🎉</span>
                  )}
                </button>
              </div>
            </footer>
          </article>

          {allDone && (
            <div className="mt-4 rounded-lg border border-long/40 bg-long/10 p-4 text-sm text-long">
              🎉 Every lesson complete. You know the system end to end — now go reproduce it trade by trade in
              the Journal.{" "}
              <button onClick={resetProgress} className="underline underline-offset-2 hover:no-underline">
                Reset progress
              </button>{" "}
              to run the course again.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
