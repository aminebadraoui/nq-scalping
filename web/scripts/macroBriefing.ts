/* ------------------------------------------------------------------ *
 * Macro briefing CLI — generates one AI macro briefing row.
 *
 *   node --import scripts/ts-loader.mjs ./scripts/macroBriefing.ts pre-open
 *   node --import scripts/ts-loader.mjs ./scripts/macroBriefing.ts post-close
 *   node --import scripts/ts-loader.mjs ./scripts/macroBriefing.ts on-demand
 *
 * Scheduled by the nq-jobs container (pre-open cron, see
 * scripts/jobs_entry.sh + scripts/briefing.sh) and appended inside
 * scripts/nightly.sh (post-close). Both containers share the analysis
 * env: ANALYSIS_LLM_URL/KEY (+ optional BRIEFING_LLM_MODEL, default
 * deepseek-v4-pro). Without the LLM env the deterministic renderer is
 * stored instead — the card still fills.
 *
 * Note: lib/macroBriefing imports the CBOE options feed singleton,
 * which keeps a poll timer alive — so this CLI exits explicitly.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateBriefing, type BriefingRow } from "../lib/macroBriefing";
import type { BriefingKind } from "../lib/briefingText";
import { marketOpenAt } from "../lib/marketHours";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* env must be set by the caller (Coolify injects it on the VPS) */
  }
}
loadEnvLocal();

const KINDS: BriefingKind[] = [
  "evening-open",
  "pre-open",
  "post-open",
  "mid-morning",
  "midday",
  "pre-close",
  "post-close",
  "on-demand",
];
const kind = (process.argv[2] ?? "pre-open") as BriefingKind;
if (!KINDS.includes(kind)) {
  console.error(`macroBriefing: unknown kind "${process.argv[2]}" (${KINDS.join(" | ")})`);
  process.exit(1);
}

/** NY wall-clock minutes since midnight (base-10 coercion, like nightly.sh) */
function nyHm(): { hhmm: string; min: number } {
  const out = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const g: Record<string, string> = {};
  for (const p of out) g[p.type] = p.value;
  return { hhmm: `${g.hour}:${g.minute}`, min: (Number(g.hour) % 24) * 60 + Number(g.minute) };
}

/** the NY window each kind may run in (keeps manual runs honest; the
 *  crons already land inside them) */
const KIND_WINDOWS: Record<Exclude<BriefingKind, "on-demand">, [number, number]> = {
  // Globex reopen 18:00 ET — the weekend gap / the evening session start
  "evening-open": [18 * 60, 19 * 60],
  "pre-open": [8 * 60 + 45, 10 * 60],
  // RTH open + the opening drive's first prints
  "post-open": [9 * 60 + 30, 10 * 60 + 15],
  // Europe close 11:30 ET — the liquidity handoff
  "mid-morning": [11 * 60, 12 * 60],
  // lunch lull reassessment
  midday: [13 * 60, 14 * 60 + 15],
  // RTH close / MOC — final positioning
  "pre-close": [15 * 60 + 45, 16 * 60 + 30],
  // nightly.sh's guard already limits it to 17:00–18:00 NY
  "post-close": [17 * 60, 18 * 60 + 30],
};

function shouldSkip(): string | null {
  if (kind === "on-demand") return null;
  if (kind !== "post-close" && !marketOpenAt(Date.now())) {
    return "market closed (holiday/weekend)";
  }
  const { min } = nyHm();
  const [lo, hi] = KIND_WINDOWS[kind];
  if (min < lo || min >= hi) return `outside the ${fmtMin(lo)}–${fmtMin(hi)} NY window`;
  return null;
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

async function main() {
  const skip = shouldSkip();
  if (skip) {
    console.log(`[briefing] ${kind}: skipping — ${skip}`);
    process.exit(0);
  }
  console.log(`[briefing] ${kind}: building snapshot + calling the model…`);
  const t0 = Date.now();
  const { row, source } = await generateBriefing(kind);
  if (!row) {
    console.error(`[briefing] ${kind}: no row persisted (DATABASE_URL missing or write failed)`);
    process.exit(1);
  }
  logRow(row, source);
  console.log(`[briefing] ${kind}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

function logRow(row: BriefingRow, source: string) {
  const bars = (row.snapshot as { nq?: { bars?: number | null } }).nq?.bars ?? null;
  console.log(`[briefing] stored id=${row.id} kind=${row.kind} source=${source} model=${row.model || "—"} bars=${bars ?? "—"}`);
  console.log(`[briefing] headline: ${row.headline}`);
  for (const l of row.read) console.log(`[briefing]   ▸ ${l}`);
  for (const w of row.watchFors) console.log(`[briefing]   ◉ ${w}`);
}

main().catch((e) => {
  console.error("[briefing] failed:", e);
  process.exit(1);
});
