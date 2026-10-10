import type { Metadata } from "next";
import Link from "next/link";
import { CoursePlayer } from "@/components/course/CoursePlayer";

export const metadata: Metadata = {
  title: "Course",
  description:
    "The manual trader's course: our NQ scalping system taught from zero — the strategies, the journal's input and gate features, execution, and the risk plan.",
};

export default function CoursePage() {
  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 pb-20 pt-6">
      <CoursePlayer />

      <p className="mt-10 border-t border-zinc-800 pt-6 font-mono text-[11px] text-zinc-600">
        Educational research only — not financial advice. The same system, condition by condition, is on the{" "}
        <Link href="/strategies" className="text-zinc-400 hover:text-zinc-200">
          strategies page
        </Link>
        ; the research and sources behind every number are on the{" "}
        <Link href="/docs" className="text-zinc-400 hover:text-zinc-200">
          docs page
        </Link>
        .
      </p>
    </div>
  );
}
