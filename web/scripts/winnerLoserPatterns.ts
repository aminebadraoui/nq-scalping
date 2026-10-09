/* ------------------------------------------------------------------ *
 * WINNER/LOSER PATTERNS — mine the full live-journal variable dump.
 *
 * Reads the reconciled `trades` rows (Neon, scripts/reconcileTrades.ts)
 * and answers, per variable, the one question that matters:
 *
 *   DID IT POINT ONE WAY?  ↑ higher → more wins · ↓ lower → more wins
 *   · split → prefers value X over Y · flat → no direction.
 *
 *   · fire-time features (signals.features jsonb, flattened) — the
 *     signal inputs AND the study-only chips (ES / seasonal / round /
 *     gap / wall / kelly / dom) recorded when the card fired;
 *   · post-hoc execution anatomy (drift, MFE/MAE, held, stop-run,
 *     target-reached, loss label) — labeled [post] because these
 *     patterns are correlated with the result BY CONSTRUCTION
 *     (MFE ≥ target ⇒ win), not pre-trade edges.
 *
 * Every variable line shows the direction + effect (lift spread in pp
 * between the two extreme cells), a strength grade (strong/mild/weak
 * over effect and sample — a reading aid, not a significance test),
 * the W%/L% split of every bucket, and the same split inside each
 * strategy family (family lift is vs that family's baseline WR).
 *
 * Run from web/:
 *   node --import scripts/ts-loader.mjs ./scripts/winnerLoserPatterns.ts
 *   node --import scripts/ts-loader.mjs ./scripts/winnerLoserPatterns.ts \
 *     --family rth --since 2026-10-01 --top 30 --min-n 5 \
 *     --all-cells --csv /tmp/wl-patterns.csv
 *
 * Env (falls back to web/.env.local): DATABASE_URL. Read-only.
 * ------------------------------------------------------------------ */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { accountForDay } from "../lib/tradeLedger";
import {
  minePatterns,
  familyBaselines,
  winLossRowsFromDb,
  POST_HOC_KEYS,
  type VarPattern,
  type WinLossRow,
} from "../lib/patternMining";
import { groupKeyOf, GROUP_ORDER } from "../lib/featureGroups";

/* ---- env ------------------------------------------------------------ */
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
    /* no .env.local — env must be set by the caller */
  }
}
loadEnvLocal();

const DB_URL = process.env.DATABASE_URL ?? "";
if (!DB_URL) {
  console.error("winnerLoserPatterns: need DATABASE_URL");
  process.exit(1);
}
const sql = postgres(DB_URL, { ssl: "require", max: 2 });

/* ---- flags ----------------------------------------------------------- */
const arg = (name: string, def = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const SINCE = arg("since", "");
const FAMILY = arg("family", "");
const ACCOUNT = arg("account", "all");
const TOP = Number(arg("top", "30")) || 30;
const MIN_N = Number(arg("min-n", "5")) || 5;
const CSV = arg("csv", "");
const ALL_CELLS = has("all-cells");

const GROUP_LABEL = new Map(GROUP_ORDER.map((g) => [g.key, g.label]));
const groupLabelOf = (key: string): string => GROUP_LABEL.get(groupKeyOf(key)) ?? "OTHER";

type DbRow = Record<string, unknown>;

/* ---- data ------------------------------------------------------------ */
async function loadTrades(): Promise<DbRow[]> {
  const where = ["t.result in ('win','loss')"];
  if (SINCE) where.push(`t.day >= '${SINCE.replace(/[^0-9-]/g, "")}'`);
  if (FAMILY) where.push(`t.family = '${FAMILY.replace(/[^a-z_]/g, "")}'`);
  return (await sql`
    select t.day, t.time_et, t.side, t.contracts, t.family, t.verdict,
           t.gross_pts, t.net_usd, t.result,
           t.sig_entry, t.sig_target,
           t.entry_adverse_pts, t.held_min, t.mfe_pts, t.mae_pts,
           t.target_reached, t.recovered, t.stop_run, t.loss_label,
           t.hour_bucket, t.first_of_day, t.features
    from trades t
    where ${sql.unsafe(where.join(" and "))}
    order by t.ts asc`) as DbRow[];
}

function toRows(raw: DbRow[]): { rows: WinLossRow[]; skipped: number } {
  let skipped = 0;
  if (ACCOUNT !== "all") {
    for (const r of raw) {
      const account = accountForDay(String(r.day)).account;
      if (ACCOUNT === "new" ? !account.endsWith("007") : account.endsWith("007")) skipped++;
    }
  }
  const filtered = ACCOUNT === "all"
    ? raw
    : raw.filter((r) => {
        const account = accountForDay(String(r.day)).account;
        return ACCOUNT === "new" ? account.endsWith("007") : !account.endsWith("007");
      });
  return { rows: winLossRowsFromDb(filtered), skipped };
}

/* ---- report ---------------------------------------------------------- */
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const wrCell = (wins: number, n: number): string => `${(n ? (wins / n) * 100 : 0).toFixed(0)}%W/${(n ? 100 - (wins / n) * 100 : 0).toFixed(0)}%L`;

const ARROWS: Record<VarPattern["direction"], string> = { up: "↑", down: "↓", flat: "→", split: "⚡" };
const ROLE: Record<VarPattern["kind"], string> = { "fire-time": "pre", "post-hoc": "post" };
const VERDICT_TAG: Record<VarPattern["verdict"], string> = { significant: "[SIG]", stable: "[STABLE]", exploratory: "[EXPL]" };

const fmtP = (v: number | null): string => (v === null ? "—" : v < 0.001 ? "<0.001" : v.toFixed(3));

function varLine(p: VarPattern): string {
  const head = `${ARROWS[p.direction]} ${p.directionLabel}`;
  return `${head} · effect ${p.effectPp >= 0 ? "+" : ""}${p.effectPp.toFixed(1)}pp · ${p.strength.toUpperCase()} · n=${p.n} · p=${fmtP(p.pValue)} · q=${fmtP(p.qValue)}${p.stable === "insufficient" ? " · stability n/a" : p.stable ? " · stable both halves" : " · unstable across halves"}`;
}

function cellsLine(p: VarPattern, max = 6): string {
  const shown = p.cells.slice(0, max);
  const parts = shown.map((c) => `${wrCell(c.wins, c.n)} ${c.label}·${c.n}`);
  return `cells: ${parts.join(" | ")}${p.cells.length > max ? ` | …+${p.cells.length - max}` : ""}`;
}

function familyLine(p: VarPattern, max = 6): string {
  if (!p.perFamily.length) return "";
  const parts = p.perFamily.slice(0, max).map((f) => `${f.family} ${wrCell(f.wins, f.n)} n=${f.n} (${f.liftPp >= 0 ? "+" : ""}${f.liftPp.toFixed(1)}pp)`);
  return `fam: ${parts.join(" · ")}${p.perFamily.length > max ? ` · …+${p.perFamily.length - max}` : ""}`;
}

async function main() {
  const raw = await loadTrades();
  if (raw.length === 0) {
    console.log("no win/loss trades match the filters (did reconcileTrades run?)");
    await sql.end();
    return;
  }
  const { rows, skipped } = toRows(raw);
  const wins = rows.filter((r) => r.result === "win").length;
  console.log("=== WINNER/LOSER PATTERNS — one variable per line, strongest direction first ===");
  console.log(`trades ${rows.length} · wins ${wins} · losses ${rows.length - wins} · baseline WR ${pct(rows.length ? wins / rows.length : 0)}`);
  if (ACCOUNT !== "all") console.log(`account: ${ACCOUNT}`);
  if (FAMILY) console.log(`family: ${FAMILY}`);
  if (SINCE) console.log(`since: ${SINCE}`);
  if (skipped) console.log(`(skipped ${skipped} rows from the other account)`);
  console.log("\nfamily baselines:");
  for (const [f, b] of [...familyBaselines(rows).entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${f.padEnd(20)} WR ${pct(b)}`);
  }
  console.log("\nkey: ↑ higher → more wins · ↓ lower → more wins · ⚡ prefers one value · → flat");
  console.log("     [pre] known at fire time · [post] execution anatomy (correlated by construction)");
  console.log("     [SIG] FDR q<0.10 · [STABLE] same direction in both time halves · [EXPL] exploratory only\n");

  const exclude = new Set<string>();
  const patterns = minePatterns(rows, { minN: MIN_N, exclude, anatomyKeys: Object.keys(POST_HOC_KEYS) });

  console.log(`=== TOP ${TOP} variables by evidence (significant → stable → exploratory) ===\n`);
  for (const p of patterns.slice(0, TOP)) {
    if (p.effectPp === 0 && p.direction === "flat") continue;
    console.log(`[${ROLE[p.kind]}·${p.type.slice(0, 4).padEnd(4)}] ${VERDICT_TAG[p.verdict]} ${p.key.padEnd(28).slice(0, 28)} (${p.kind === "post-hoc" ? "ANATOMY" : groupLabelOf(p.key)})`);
    console.log(`   ${varLine(p)}`);
    console.log(`   ${cellsLine(p)}`);
    const fl = familyLine(p);
    if (fl) console.log(`   ${fl}`);
  }

  if (ALL_CELLS) {
    console.log(`\n=== ALL VARIABLES — full cells + family split ===\n`);
    for (const p of patterns) {
      console.log(`${p.key}  [${p.kind === "post-hoc" ? "ANATOMY (post-hoc)" : groupLabelOf(p.key)}]  ${varLine(p)}`);
      for (const c of p.cells) {
        console.log(`   ${c.label.padEnd(26).slice(0, 26)} n=${String(c.n).padStart(3)}  ${wrCell(c.wins, c.n)}  lift ${c.liftPp >= 0 ? "+" : ""}${c.liftPp.toFixed(1)}pp${c.meanValue !== null ? ` · mean ${c.meanValue}` : ""}`);
      }
      for (const f of p.perFamily) {
        console.log(`   └ ${f.family}: n=${f.n} ${wrCell(f.wins, f.n)} lift ${f.liftPp >= 0 ? "+" : ""}${f.liftPp.toFixed(1)}pp (vs family baseline)`);
      }
    }
  }

  if (CSV) {
    const head = "role,group,variable,type,direction,direction_label,effect_pp,strength,p_value,q_value,stable,verdict,cell,n,wins,wr,lift_pp,mean_value";
    const lines = [head];
    for (const p of patterns) {
      for (const c of p.cells) {
        lines.push(
          [
            p.kind,
            p.kind === "post-hoc" ? "ANATOMY (post-hoc)" : groupLabelOf(p.key),
            p.key,
            p.type,
            p.direction,
            `"${p.directionLabel.replace(/"/g, '""')}"`,
            p.effectPp.toFixed(2),
            p.strength,
            p.pValue === null ? "" : p.pValue,
            p.qValue === null ? "" : p.qValue,
            p.stable ?? "",
            p.verdict,
            `"${c.label.replace(/"/g, '""')}"`,
            c.n,
            c.wins,
            c.wr.toFixed(4),
            c.liftPp.toFixed(2),
            c.meanValue === null ? "" : c.meanValue,
          ].join(","),
        );
      }
    }
    writeFileSync(CSV, lines.join("\n") + "\n");
    console.log(`\ncsv → ${CSV}`);
  }

  console.log(
    "\nmethods: p — Mann-Whitney (numeric, raw values) · Fisher exact on the extreme 2×2 (categorical) · Cochran-Mantel-Haenszel stratified by family (presence).\n" +
      "q — Benjamini-Hochberg FDR across every variable tested in this run; [SIG] = q < 0.10.\n" +
      "stability — the direction recomputed on the early vs late half of the time-ordered trades; [STABLE] = same non-flat direction, ≥2pp effect in BOTH halves; 'stability n/a' = a half lacked enough rows.\n" +
      "ranking — significant > stable > exploratory, then |effect|. Reading aids on live journal samples, not a substitute for the archive studies' train/test discipline.\n" +
      "[post] anatomy patterns diagnose execution; they don't gate. Fire-time study features (ES/seasonal/round/gap/wall/kelly/dom) were known at fire time but never gated the card. Cells with n < min-n print but don't rank.",
  );
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
