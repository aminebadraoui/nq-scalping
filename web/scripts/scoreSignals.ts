/* Signal win/loss scoring — replays every recorded signal against the
 * collected session files and writes the outcome columns (observational
 * only; the signal engine never reads them).
 *
 *   node --import ../scripts/ts-loader.mjs ./scripts/scoreSignals.ts
 *
 * Idempotent: re-scoring is deterministic, so the nightly pipeline can
 * simply re-run it after reconcile and any repaired session file flows
 * through on the next pass.
 */
import { getDb, dbEnabled } from "../lib/gcdb";
import { scoreSignalFromFiles, toScorable } from "../lib/signalOutcomes";
import { updateSignalOutcome } from "../lib/signalHistory";
import { cdtToET } from "../lib/times";

type Row = {
  key: string;
  day: string;
  time_et: string;
  side: string;
  entry: string;
  stop: string;
  target: string;
  verdict: string;
  headline: string;
};

async function main() {
  if (!dbEnabled()) {
    console.error("DATABASE_URL is not set — nothing to score");
    process.exit(1);
  }
  const rows = (await getDb()`
    select key, day, time_et, side, entry, stop, target, verdict, headline
    from signals
    where side in ('long','short')
    order by ts asc`) as unknown as Row[];
  console.log(`scoring ${rows.length} signal(s) against the collected sessions…`);

  const counts: Record<string, number> = { win: 0, loss: 0, time: 0, open: 0, unscored: 0, skipped: 0 };
  const perDay = new Map<string, { wins: number; total: number }>();
  let scored = 0;

  for (const r of rows) {
    const s = toScorable({ key: r.key, day: r.day, timeET: r.time_et, side: r.side, entry: r.entry, stop: r.stop, target: r.target });
    if (!s) {
      counts.skipped++;
      console.log(`  − ${r.day} ${r.time_et} NY ${r.side} — not scorable (text levels / no side)`);
      continue;
    }
    const o = await scoreSignalFromFiles(s);
    if (!o || o.outcome === "") {
      counts.unscored++;
      console.log(`  ? ${s.day} ${s.timeET} NY ${s.side} @ ${s.entry.toFixed(2)} — entry bar not found in any session file`);
      continue;
    }
    await updateSignalOutcome(s.key, {
      outcome: o.outcome,
      exitPrice: o.exitPrice,
      exitTime: o.exitTime ?? "",
      exitReason: o.exitReason ?? "",
      mfePts: o.mfePts,
      maePts: o.maePts,
    });
    scored++;
    counts[o.outcome]++;
    const d = perDay.get(s.day) ?? { wins: 0, total: 0 };
    d.total++;
    if (o.outcome === "win") d.wins++;
    perDay.set(s.day, d);
    const pnl = o.exitPrice !== null ? (o.exitPrice - s.entry) * (s.side === "long" ? 1 : -1) : 0;
    const exitNY = o.exitTime ? cdtToET(o.exitTime) : "";
    console.log(
      `  ${o.outcome === "win" ? "✓" : o.outcome === "loss" ? "✗" : "⏱"} ${s.day} ${s.timeET} NY ${s.side.padEnd(5)} ${s.entry.toFixed(2)} → ${o.outcome}${o.exitReason === "time" ? ` (time ${exitNY})` : ` (${o.exitReason} ${exitNY})`} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pts · MFE ${o.mfePts?.toFixed(2) ?? "—"}`,
    );
  }

  const closed = counts.win + counts.loss + counts.time;
  const wins = counts.win + (counts.time > 0 ? 0 : 0); // time exits are their own bucket; win% uses target/stop only below
  console.log(`\n=== outcome summary ===`);
  console.log(`scored ${scored} · win ${counts.win} · loss ${counts.loss} · time ${counts.time} · open ${counts.open} · unscored ${counts.unscored} · skipped ${counts.skipped}`);
  if (closed > 0) console.log(`win rate (target/stop closes): ${((counts.win / closed) * 100).toFixed(1)}% · with time-exit winners: ${((wins + counts.time) / closed * 100).toFixed(1)}%`);
  const days = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [day, d] of days) {
    console.log(`  ${day}: ${d.wins}/${d.total} wins (${((d.wins / d.total) * 100).toFixed(0)}%)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
