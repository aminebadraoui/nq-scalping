"use client";

/* ------------------------------------------------------------------ *
 * ReversalReadView — the reversal composer read, live and in full.
 *
 * Presentational only: receives the /api/signal payload and renders
 * EVERY box in complete detail: vote, tone, conviction score, verdict
 * text, the order-flow ingredient checklist (yes/partial/no + the full
 * why), the card-gate verdict that decides whether the card is pushed
 * to Telegram, and the trade ticket lines. Nothing is truncated — long
 * verdicts wrap instead of being cut.
 *
 * Rendered as the REVERSAL tab of the live signal board
 * (LiveSignalBoard) and usable standalone.
 * ------------------------------------------------------------------ */

export type BoxRead = {
  id: string;
  name: string;
  side: "long" | "short" | null;
  tone: "long" | "short" | "neutral" | "forming";
  score: number;
  verdict: string;
  kind: "directional" | "context";
  label: string | null;
};

export type IngredientRead = {
  key: string;
  n: string;
  name: string;
  role: "required" | "support" | "filter";
  state: "yes" | "partial" | "no";
  short: string;
  value: string;
  why: string;
};

export type SignalRead = {
  side: "long" | "short" | null;
  tone: "long" | "short" | "neutral" | "forming";
  agree: boolean;
  verdict: string;
  headline: string;
  boxes: BoxRead[];
  contextNotes: string[];
  gate: { ok: boolean; reason: string };
  ingredients: IngredientRead[];
  present: number;
  lastPrice: number;
  timeET: string;
  day: string;
  source: string;
  minutes: number;
  symbol: string;
  vwap: number;
  orderflow: { side: string | null; tone: string; verdict: string; trigger: string; invalidation: string; target: string };
  pullback: { side: string | null; tone: string; verdict: string; trigger: string; invalidation: string; target: string };
  priceaction: string | null;
  options: string | null;
};

export type ReversalReadProps = {
  feeds: Record<string, boolean> | null;
  signal: SignalRead | null;
};

const f = (n: number, dp = 2) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—";

const SIDE_STYLE: Record<string, string> = {
  long: "border-long/50 bg-long/10 text-long",
  short: "border-short/50 bg-short/10 text-short",
  neutral: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
  forming: "border-warn/50 bg-warn/10 text-warn",
};

const SIDE_LABEL: Record<string, string> = {
  long: "🟢 LONG",
  short: "🔴 SHORT",
  neutral: "⚪ NO TRADE",
  forming: "◐ FORMING",
};

const ING_ICON: Record<string, string> = { yes: "✅", partial: "◐", no: "✗" };
const ING_TEXT: Record<string, string> = { yes: "text-long", partial: "text-warn", no: "text-short" };
const ROLE_STYLE: Record<string, string> = {
  required: "border-long/40 bg-long/10 text-long",
  support: "border-info/40 bg-info/10 text-info",
  filter: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};

export default function ReversalReadView({ feeds, signal: sig }: ReversalReadProps) {
  return (
    <div className="space-y-2">
      {!sig && (
        <p className="font-mono text-[10px] leading-snug text-zinc-500">
          no live snapshot yet — the composer computes one every cycle from the live tape
        </p>
      )}

      {sig && (
        <div className="space-y-2">
          {/* ---- status: side, tone, time, price ---- */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${SIDE_STYLE[sig.tone] ?? "border-zinc-700 text-zinc-300"}`}>
              {SIDE_LABEL[sig.side ?? "neutral"]}
            </span>
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${SIDE_STYLE[sig.tone] ?? "border-zinc-700 text-zinc-300"}`}>
              {sig.agree ? "ALL BOXES AGREE" : "NOT ALL BOXES HAVE VOTED"}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">
              {sig.symbol} {f(sig.lastPrice)} · {sig.day} {sig.timeET} NY · {sig.source}
            </span>
          </div>

          {/* ---- headline + verdict, full ---- */}
          <p className="break-words font-mono text-[12px] font-semibold leading-snug text-zinc-100">{sig.headline}</p>
          <p className="break-words font-mono text-[10px] leading-snug text-zinc-400">{sig.verdict}</p>

          {/* ---- the card gate: would Telegram get this right now? ---- */}
          <div className={`rounded border px-2 py-1.5 ${sig.gate.ok ? "border-long/40 bg-long/10" : "border-short/40 bg-short/10"}`}>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
              <span className={`font-bold ${sig.gate.ok ? "text-long" : "text-short"}`}>
                {sig.gate.ok ? "✓ CARD GATE OPEN" : "⛔ CARD GATE CLOSED"} — Telegram push {sig.gate.ok ? "allowed" : "blocked"}
              </span>
              <span className="text-zinc-500">
                · reversal feed {feeds?.reversal ? "ON" : "OFF (paused — owner rule)"}
              </span>
            </div>
            <p className="mt-0.5 break-words font-mono text-[10px] leading-snug text-zinc-300">{sig.gate.reason}</p>
          </div>

          {/* ---- every box, fully ---- */}
          <div className="space-y-1.5">
            {sig.boxes.map((b) => (
              <div key={b.id} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                  <span className="font-bold uppercase tracking-wider text-zinc-200">{b.name}</span>
                  <span
                    className={`rounded border px-1 py-px text-[8px] uppercase ${
                      b.kind === "context" ? "border-zinc-700 bg-zinc-800/40 text-zinc-500" : "border-info/40 bg-info/10 text-info"
                    }`}
                    title={b.kind === "context" ? "context box — reports the regime, never votes" : "directional box — votes long/short"}
                  >
                    {b.kind === "context" ? "context" : "votes"}
                  </span>
                  <span className={`rounded border px-1 py-px text-[9px] font-semibold ${SIDE_STYLE[b.tone] ?? "border-zinc-700 text-zinc-300"}`}>
                    {b.kind === "context" ? (b.label ?? "—") : b.side === "long" ? "LONG" : b.side === "short" ? "SHORT" : "no vote yet"}
                  </span>
                  {b.kind === "directional" && (
                    <span className="text-zinc-500">conviction {Math.round(b.score * 100)}%</span>
                  )}
                </div>
                <p className="mt-1 break-words font-mono text-[10px] leading-snug text-zinc-300">{b.verdict}</p>
              </div>
            ))}
          </div>

          {/* ---- the order-flow checklist: every ingredient, full ---- */}
          <div className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-1.5 font-mono text-[10px]">
              <span className="font-bold uppercase tracking-wider text-zinc-200">Order flow checklist</span>
              <span className="text-zinc-500">{sig.present}/6 present · required = location + mechanism + trigger</span>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {sig.ingredients.map((i) => (
                <div key={i.key} className="border-t border-zinc-800/60 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                    <span className={ING_TEXT[i.state]}>{ING_ICON[i.state]}</span>
                    <span className="font-semibold text-zinc-200">{i.name}</span>
                    <span className={`rounded border px-1 py-px text-[8px] uppercase ${ROLE_STYLE[i.role]}`}>{i.role}</span>
                    <span className="break-words text-zinc-400">{i.short}</span>
                  </div>
                  <p className="mt-0.5 break-words font-mono text-[9px] leading-snug text-zinc-500">{i.value}</p>
                  <p className="mt-0.5 break-words font-mono text-[9px] leading-snug text-zinc-600">{i.why}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ---- the ticket lines ---- */}
          <div className="space-y-0.5 rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5 font-mono text-[10px] leading-snug">
            <p className="break-words"><span className="text-zinc-500">TRIGGER</span> {sig.orderflow.trigger}</p>
            <p className="break-words"><span className="text-zinc-500">STOP</span> {sig.orderflow.invalidation}</p>
            <p className="break-words"><span className="text-zinc-500">TARGET</span> {sig.orderflow.target}</p>
          </div>

          {/* ---- pullback watch (never a voter, never notified) ---- */}
          <p className="break-words font-mono text-[9px] leading-snug text-zinc-600">
            pullback watch (not a voter): {sig.pullback.verdict} · {sig.pullback.trigger} · {sig.pullback.invalidation}
          </p>

          {/* ---- context notes ---- */}
          {sig.contextNotes.length > 0 && (
            <p className="break-words font-mono text-[9px] leading-snug text-zinc-500">
              {sig.contextNotes.join(" · ")}
            </p>
          )}

          {/* ---- footer ---- */}
          <p className="break-words font-mono text-[9px] leading-snug text-zinc-600">
            {sig.minutes} live minutes · VWAP {f(sig.vwap)} · snapshot refreshes every ~15s
          </p>
        </div>
      )}
    </div>
  );
}
