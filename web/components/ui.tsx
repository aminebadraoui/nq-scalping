import Link from "next/link";
import type { ReactNode } from "react";

export type Tone = "long" | "short" | "warn" | "info" | "muted";

const toneText: Record<Tone, string> = {
  long: "text-long",
  short: "text-short",
  warn: "text-warn",
  info: "text-info",
  muted: "text-zinc-400",
};

const toneBorder: Record<Tone, string> = {
  long: "border-long/40",
  short: "border-short/40",
  warn: "border-warn/40",
  info: "border-info/40",
  muted: "border-zinc-800",
};

export function Section({
  kicker,
  title,
  lede,
  children,
  id,
}: {
  kicker?: string;
  title: string;
  lede?: string;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="mb-14">
      {kicker && (
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-long">
          {kicker}
        </p>
      )}
      <h2 className="mb-2 text-2xl font-bold tracking-tight text-zinc-50 sm:text-3xl">
        {title}
      </h2>
      {lede && <p className="mb-6 max-w-3xl leading-relaxed text-zinc-400">{lede}</p>}
      {children}
    </section>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`my-6 rounded-lg border ${toneBorder[tone]} bg-zinc-900/60 p-4`}
    >
      {title && (
        <p className={`mb-1.5 font-mono text-sm font-semibold ${toneText[tone]}`}>
          {title}
        </p>
      )}
      <div className="text-sm leading-relaxed text-zinc-300">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "warn",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="font-mono text-xs uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className={`mt-1 font-mono text-3xl font-bold ${toneText[tone]}`}>
        {value}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{sub}</p>
    </div>
  );
}

export function Pill({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-xs ${toneBorder[tone]} ${toneText[tone]}`}
    >
      {children}
    </span>
  );
}

export function DataTable({
  head,
  rows,
}: {
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            {head.map((h) => (
              <th
                key={h}
                className="px-4 py-3 font-mono text-xs uppercase tracking-wider text-zinc-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-900"
            >
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`px-4 py-3 align-top leading-relaxed text-zinc-300 ${
                    j === 0 ? "font-medium text-zinc-100" : ""
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SourceRef({ label, href }: { label: string; href: string }) {
  return (
    <li className="text-sm">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-info underline-offset-4 hover:underline"
      >
        {label}
      </a>
    </li>
  );
}

export function Card({
  title,
  tag,
  children,
}: {
  title: string;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold text-zinc-100">{title}</h3>
        {tag && (
          <span className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 font-mono text-xs text-zinc-400">
            {tag}
          </span>
        )}
      </div>
      <div className="space-y-2 text-sm leading-relaxed text-zinc-400">
        {children}
      </div>
    </div>
  );
}

export function StepList({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-xs text-long">
            {i + 1}
          </span>
          <p className="text-sm leading-relaxed text-zinc-300">
            <span className="font-semibold text-zinc-100">{s.title} — </span>
            {s.body}
          </p>
        </li>
      ))}
    </ol>
  );
}
