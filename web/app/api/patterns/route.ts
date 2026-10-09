/* ------------------------------------------------------------------ *
 * Pattern explorer API — winner/loser patterns over the full journal
 * variable dump, computed with lib/patternMining.ts (the same engine
 * as scripts/winnerLoserPatterns.ts, so the CLI and this panel always
 * agree).
 *
 * GET /api/patterns?since=YYYY-MM-DD&family=rth&minN=5&account=all
 *
 * One entry per variable: direction + effect + strength, every cell's
 * W%/L% split, and the same split inside each strategy family.
 * Read-only — never writes.
 * ------------------------------------------------------------------ */

import type { NextRequest } from "next/server";
import { dbEnabled, getDb } from "@/lib/gcdb";
import { accountForDay } from "@/lib/tradeLedger";
import {
  minePatterns,
  winLossRowsFromDb,
  POST_HOC_KEYS,
  type VarPattern,
} from "@/lib/patternMining";
import { groupKeyOf, GROUP_ORDER } from "@/lib/featureGroups";

export const dynamic = "force-dynamic";

const GROUP_LABEL = new Map(GROUP_ORDER.map((g) => [g.key, g.label]));
const groupLabelOf = (key: string): string => GROUP_LABEL.get(groupKeyOf(key)) ?? "OTHER";

export async function GET(req: NextRequest) {
  if (!dbEnabled()) {
    return Response.json({ ok: false, reason: "no database configured" });
  }
  const sp = req.nextUrl.searchParams;
  const since = (sp.get("since") ?? "").replace(/[^0-9-]/g, "");
  const family = (sp.get("family") ?? "").replace(/[^a-z_]/g, "");
  const minN = Number(sp.get("minN") ?? "5") || 5;
  const account = sp.get("account") ?? "all";

  try {
    const db = getDb();
    const raw = (await db`
      select t.day, t.time_et, t.side, t.contracts, t.family, t.verdict,
             t.result, t.hour_bucket, t.first_of_day,
             t.entry_adverse_pts, t.held_min, t.mfe_pts, t.mae_pts,
             t.target_reached, t.recovered, t.stop_run, t.loss_label,
             t.features
      from trades t
      where t.result in ('win','loss')
        ${since ? db`and t.day >= ${since}` : db``}
        ${family ? db`and t.family = ${family}` : db``}
      order by t.ts asc`) as Array<Record<string, unknown>>;

    const filtered =
      account === "all"
        ? raw
        : raw.filter((r) => {
            const a = accountForDay(String(r.day)).account;
            return account === "new" ? a.endsWith("007") : !a.endsWith("007");
          });
    const rows = winLossRowsFromDb(filtered);
    const wins = rows.filter((r) => r.result === "win").length;

    const famStats = new Map<string, { n: number; wins: number }>();
    for (const r of rows) {
      const f = String(r.anatomy.family ?? "other");
      const s = famStats.get(f) ?? { n: 0, wins: 0 };
      s.n++;
      if (r.result === "win") s.wins++;
      famStats.set(f, s);
    }

    const patterns: Array<VarPattern & { group: string }> = minePatterns(rows, {
      minN,
      anatomyKeys: Object.keys(POST_HOC_KEYS),
    }).map((p) => ({ ...p, group: p.kind === "post-hoc" ? "ANATOMY (post-hoc)" : groupLabelOf(p.key) }));

    return Response.json({
      ok: true,
      source: "db",
      n: rows.length,
      wins,
      losses: rows.length - wins,
      baselineWr: rows.length > 0 ? wins / rows.length : 0,
      familyBaselines: [...famStats.entries()]
        .map(([family, s]) => ({ family, n: s.n, wins: s.wins, wr: s.n > 0 ? s.wins / s.n : 0 }))
        .sort((a, b) => b.n - a.n),
      patterns,
    });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
