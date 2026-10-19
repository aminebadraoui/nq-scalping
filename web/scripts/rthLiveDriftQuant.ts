/* ------------------------------------------------------------------ *
 * RTH live drift quantification (read-only, Neon trades ledger).
 * Intervention (b) input: signal stop distance vs EFFECTIVE stop
 * distance after fill drift, plus stop-fill slippage, for every filled
 * RTH trade — the live evidence for the compressed-stop mechanism.
 * ------------------------------------------------------------------ */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 2 });

type Row = {
  day: string;
  time_et: string;
  side: string;
  sig_entry: number;
  fill_entry: number;
  sig_stop: number;
  sig_target: number;
  exit_avg: number | null;
  gross_pts: number | null;
  entry_adverse_pts: number | null;
  held_min: number | null;
  result: string;
};

async function main() {
  const rows = (await sql`
    select day, time_et, side, sig_entry::float8 sig_entry, fill_entry::float8 fill_entry,
           sig_stop::float8 sig_stop, sig_target::float8 sig_target, exit_avg::float8 exit_avg,
           gross_pts::float8 gross_pts, entry_adverse_pts::float8 entry_adverse_pts,
           held_min::float8 held_min, result
    from trades
    where family in ('session_continuation','rth') and fill_entry is not null and sig_stop is not null
    order by ts`) as Row[];

  console.log("day | time | side | planned stopDist | drift (adverse+) | effective stopDist | compression % | stop slip | result | held_min");
  let n = 0;
  let sumComp = 0;
  let sumDrift = 0;
  let sumSlip = 0;
  let slipN = 0;
  const ratios: number[] = [];
  for (const r of rows) {
    const dirLong = r.side === "long";
    const planned = Math.abs(r.sig_entry - r.sig_stop);
    const drift = (r.fill_entry - r.sig_entry) * (dirLong ? 1 : -1); // − = adverse (short filled higher / long filled lower)
    const effective = Math.abs(r.fill_entry - r.sig_stop);
    const comp = planned > 0 ? Math.max(0, Math.min(100, (1 - effective / planned) * 100)) : 0;
    let slip = 0;
    if (r.exit_avg !== null && r.result === "loss") {
      slip = (r.exit_avg - r.sig_stop) * (dirLong ? 1 : -1); // − = beyond the stop (worse fill)
      if (slip < 0) {
        sumSlip += -slip;
        slipN++;
      }
    }
    n++;
    sumComp += comp;
    sumDrift += drift;
    ratios.push(effective / planned);
    console.log(
      `${r.day} | ${r.time_et} | ${r.side.padEnd(5)} | ${planned.toFixed(2).padStart(6)} | ${drift.toFixed(2).padStart(7)} | ${effective.toFixed(2).padStart(8)} | ${comp.toFixed(0).padStart(3)}% | ${slip < 0 ? (-slip).toFixed(2) : "0.00"} | ${r.result.padEnd(4)} | ${(r.held_min ?? 0).toFixed(2)}`,
    );
  }
  console.log(`\nn=${n} · avg adverse fill drift ${(-sumDrift / n).toFixed(2)} pts · avg effective-stop compression ${(sumComp / n).toFixed(0)}% · stop-fill slippage on ${slipN} stopped trades avg +${(slipN ? sumSlip / slipN : 0).toFixed(2)} pts`);
  const fresh = rows.filter((r) => r.day === "2026-10-12");
  if (fresh.length) {
    const fDrift = fresh.reduce((a, r) => a - (r.fill_entry - r.sig_entry) * (r.side === "long" ? 1 : -1), 0);
    const fComp = fresh.reduce((a, r) => {
      const planned = Math.abs(r.sig_entry - r.sig_stop);
      const effective = Math.abs(r.fill_entry - r.sig_stop);
      return a + Math.max(0, Math.min(100, (1 - effective / planned) * 100));
    }, 0);
    console.log(`fresh 2026-10-13 cards: n=${fresh.length} · avg adverse fill drift +${(fDrift / fresh.length).toFixed(2)} pts · avg compression ${(fComp / fresh.length).toFixed(0)}% · stopped within ${Math.max(...fresh.map((r) => r.held_min ?? 0)).toFixed(2)} min`);
  }
  await sql.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
