/* ------------------------------------------------------------------ *
 * Signal → Telegram card formatter.
 *
 * Pure function: takes the composed signal plus its three box reads and
 * renders a mobile-friendly HTML message the owner can read in a couple
 * of seconds and act on in TradingView. HTML parse mode is used (bold /
 * code), so everything dynamic is escaped with escHtml.
 *
 * Layout is deliberately "trade ticket" shaped: direction, instrument
 * and time on top, then ENTRY / STOP / TARGET (the three numbers you
 * actually place the order with), then the full reasoning, then the two
 * context boxes. The reasoning is the checklist — every ingredient with
 * its state — because that is what "easy to read" has to mean here: the
 * why is the product.
 * ------------------------------------------------------------------ */

import type { Signal } from "./signals";
import type { MechanismRead, Ingredient } from "./mechanism";
import type { PullbackRead } from "./pullback";
import type { PriceActionRead } from "./priceaction";
import type { OptionsRead } from "./options";
import { escHtml } from "./notify";

export type SignalContext = {
  symbol: string;
  price: number;
  timeET: string;
  /** label for the data source: "live" when ticks are flowing, else "collected" */
  source: string;
};

function fmt(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function icon(state: Ingredient["state"]): string {
  return state === "yes" ? "✅" : state === "partial" ? "◐" : "✗";
}

function sideHead(side: Signal["side"]): string {
  if (side === "long") return "🟢 LONG";
  if (side === "short") return "🔴 SHORT";
  return "⚪ NO TRADE";
}

export function formatSignalHtml(
  signal: Signal,
  read: MechanismRead | PullbackRead,
  pa: PriceActionRead,
  opt: OptionsRead | null,
  ctx: SignalContext,
  setup: string = "REVERSAL",
): string {
  const L: string[] = [];

  L.push(`🔔 <b>NQ SCALP SIGNAL · ${escHtml(setup)} — ${sideHead(signal.side)}</b>`);
  L.push(`<code>${escHtml(ctx.symbol)}  ${fmt(ctx.price)}  ${escHtml(ctx.timeET)} NY</code>`);

  // ---- verdict + box votes ----
  L.push("");
  L.push(`<b>${escHtml(signal.verdict)}</b>`);
  const boxLines = signal.boxes.map((b) => {
    const vote =
      b.kind === "context"
        ? (b.label ?? "—")
        : b.side === "long"
          ? "LONG"
          : b.side === "short"
            ? "SHORT"
            : "—";
    return `<code>${escHtml(b.name).padEnd(16, " ")}${escHtml(vote)}</code>`;
  });
  L.push(...boxLines);
  if (signal.contextNotes.length) {
    L.push(`<i>${escHtml(signal.contextNotes.join(" · "))}</i>`);
  }

  // ---- the trade ticket ----
  L.push("");
  L.push("<b>ENTRY / TRIGGER</b>");
  L.push(escHtml(read.trigger));
  L.push("");
  L.push("<b>STOP (invalidation)</b>");
  L.push(escHtml(read.invalidation));
  L.push("");
  L.push("<b>TARGET</b>");
  L.push(escHtml(read.target));

  // ---- reasoning: the full checklist ----
  L.push("");
  L.push("<b>REASONING</b>");
  for (const ing of read.ingredients) {
    L.push(`${icon(ing.state)} <code>${escHtml(ing.n)} ${escHtml(ing.name).padEnd(11, " ")}</code>${escHtml(ing.short)}`);
  }

  // ---- narrative in words ----
  if (read.narrative) {
    L.push("");
    L.push(`<i>${escHtml(read.narrative)}</i>`);
  }

  // ---- price action box ----
  L.push("");
  L.push("<b>PRICE ACTION</b>");
  L.push(escHtml(pa.verdict));
  if (pa.narrative) L.push(`<i>${escHtml(pa.narrative)}</i>`);

  // ---- options / gamma box ----
  if (opt) {
    L.push("");
    L.push("<b>OPTIONS / GAMMA</b>");
    L.push(escHtml(opt.note));
    const walls: string[] = [];
    if (opt.callWallNq !== null) walls.push(`call wall ${fmt(opt.callWallNq)}`);
    if (opt.putWallNq !== null) walls.push(`put wall ${fmt(opt.putWallNq)}`);
    if (opt.flipNq !== null) walls.push(`flip ${fmt(opt.flipNq)}`);
    if (walls.length) L.push(`<code>${escHtml(walls.join(" · "))}</code>`);
  }

  // ---- footer ----
  L.push("");
  L.push(
    `<i>${escHtml(ctx.source)} · journal every trade — every threshold here is still a hypothesis.</i>`,
  );

  return L.join("\n");
}
