/* BentoCard — shared card chrome for the bento bands.
 * Linear-style dark tokens: bg steps (not shadows), white-hairline
 * borders, muted hover lift. Type: kicker 10px/500 @0.14em, title
 * 13px/600, values mono + tabular-nums. Spec:
 * docs/data/bento-dashboard-spec.md */

import type { ReactNode } from "react";

export type BentoTone = "long" | "short" | "warn" | "info" | "muted";

const KICKER_TONE: Record<BentoTone, string> = {
  long: "text-long",
  short: "text-short",
  warn: "text-warn",
  info: "text-info",
  muted: "text-zinc-500",
};

export function BentoCard({
  kicker,
  title,
  badge,
  tone = "muted",
  hero = false,
  children,
  className = "",
}: {
  kicker?: string;
  title?: string;
  badge?: ReactNode;
  tone?: BentoTone;
  /** hero cards get the gradient top hairline */
  hero?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`relative flex h-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-panel p-4 transition-colors hover:border-zinc-700 hover:bg-[#121216] ${className}`}
    >
      {hero && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-long/60 via-info/25 to-transparent" />
      )}
      {(kicker || title || badge) && (
        <header className="mb-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {kicker && (
              <p className={`mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] ${KICKER_TONE[tone]}`}>{kicker}</p>
            )}
            {title && <h3 className="truncate text-[13px] font-semibold tracking-tight text-zinc-200">{title}</h3>}
          </div>
          {badge && <span className="shrink-0 font-mono text-[10px] text-zinc-500">{badge}</span>}
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/** tiny section label inside a card (groups tiles within a card) */
export function CardGroupLabel({ children, tone = "muted" }: { children: ReactNode; tone?: BentoTone }) {
  return (
    <p className={`mb-1 mt-2 font-mono text-[9px] uppercase tracking-[0.18em] first:mt-0 ${KICKER_TONE[tone]}`}>
      {children}
    </p>
  );
}

/** rounded-full accent chip with a status dot — regime/calendar chips */
export function TintChip({
  label,
  value,
  tone = "muted",
  urgent = false,
}: {
  label: string;
  value: ReactNode;
  tone?: BentoTone;
  urgent?: boolean;
}) {
  const tones: Record<BentoTone, string> = {
    long: "border-long/25 bg-long/10 text-long",
    short: "border-short/25 bg-short/10 text-short",
    warn: "border-warn/25 bg-warn/10 text-warn",
    info: "border-info/25 bg-info/10 text-info",
    muted: "border-zinc-700/70 bg-zinc-900/50 text-zinc-300",
  };
  const dot: Record<BentoTone, string> = {
    long: "bg-long",
    short: "bg-short",
    warn: "bg-warn",
    info: "bg-info",
    muted: "bg-zinc-500",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-tight ${
        urgent ? "border-warn/50 bg-warn/10 text-warn" : tones[tone]
      }`}
    >
      <span className={`h-1 w-1 rounded-full ${urgent ? "bg-warn" : dot[tone]}`} />
      <span className="uppercase tracking-wider text-[8px] opacity-70">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}
