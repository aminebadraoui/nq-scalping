/* ------------------------------------------------------------------ *
 * Macro interpretation CLI — generates one macro_interpretations row
 * (per-metric reads + per-family combination reads + the combined
 * cross-family read) for the Macro tab.
 *
 *   node --import scripts/ts-loader.mjs ./scripts/macroInterpret.ts
 *
 * Scheduled by the nq-jobs container (pre-open cron, see
 * scripts/jobs_entry.sh + scripts/interpret.sh) and appended inside
 * scripts/nightly.sh (post-close). Both containers share the analysis
 * env: ANALYSIS_LLM_URL/KEY (+ optional INTERPRET_LLM_MODEL, default
 * deepseek-v4-pro). Without the LLM env the deterministic renderer is
 * stored instead — the tab still fills.
 *
 * Unlike the briefing CLI there are no time-of-day windows: the read
 * describes the CURRENT state of every macro source, so any time on
 * any day is a valid snapshot (vintages are stated in the caveats).
 *
 * Note: lib/macroWatch imports the CBOE options feed singleton, which
 * keeps a poll timer alive — so this CLI exits explicitly.
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateInterpretation } from "../lib/macroInterpret";

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

async function main() {
  console.log("[macro-interpret] building the metric snapshot + calling the model…");
  const t0 = Date.now();
  const { row, source } = await generateInterpretation();
  if (!row) {
    console.error("[macro-interpret] no row persisted (DATABASE_URL missing or write failed)");
    process.exit(1);
  }
  console.log(`[macro-interpret] stored id=${row.id} source=${source} model=${row.model || "—"}`);
  console.log(`[macro-interpret] combined: ${row.combined.stance.toUpperCase()} · ${row.combined.headline}`);
  for (const l of row.combined.read) console.log(`[macro-interpret]   ▸ ${l}`);
  for (const f of row.families) console.log(`[macro-interpret]   ${f.id}: ${f.explain} — NQ: ${f.nqImpact}`);
  for (const n of row.news.slice(0, 2)) console.log(`[macro-interpret]   news ${n.id}: ${n.explain} — NQ: ${n.nqImpact}`);
  const sample = row.metrics.slice(0, 3).map((m) => `[${m.id}] ${m.explain}`).join("\n[macro-interpret]   ");
  console.log(`[macro-interpret]   ${sample}`);
  console.log(`[macro-interpret] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[macro-interpret] failed:", e);
  process.exit(1);
});
