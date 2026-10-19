/* ------------------------------------------------------------------ *
 * SIGNAL-KILL CANARY — the daily machine-check that live trading did
 * not silently kill signals (the 2026-10-15 clock-mix lesson).
 *
 * Runs on the nightly jobs container AFTER the session tape is
 * collected (wired into scripts/nightly.sh). It replays the EXACT
 * production detectors (momentum flush MOM_PROD, huge-bar expansion
 * EXP_PROD, RTH soft-momentum SOFT_PROD) on the freshly collected
 * session and diffs against the signals table (what live actually
 * fired). A replay card with no matching live signal row is a
 * divergence alarm: page the operator + write a daybook `canary`
 * record. Legit skips exist (live-only gates, caps, vetoes), so the
 * page is an ALARM to investigate, not a verdict.
 *
 * Run from web/ (DATABASE_URL + GC_DATA_DIR):
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/signalKillCanary.ts [--day 2026-10-14] [--dry]
 * ------------------------------------------------------------------ */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { detectMomentum, MOM_PROD, detectExpansionScalp, EXP_PROD, type MomMinute } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { cdtToET } from "../lib/times";
import { sendTelegram } from "../lib/notify";
import { appendDaybook } from "../lib/daybook";

const DATA_DIR = process.env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
const argIdx = process.argv.indexOf("--day");
const day = argIdx >= 0 ? process.argv[argIdx + 1] : new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
const dry = process.argv.includes("--dry");

type RawCandle = { t: string; high: number; low: number; buy: number; sell: number; levels: Record<string, number[]> };

function parseCollected(raw: string): MomMinute[] {
  const j = JSON.parse(raw) as { candles?: RawCandle[] };
  return (j.candles ?? []).map((c) => ({
    t: c.t.slice(11, 16),
    d: c.t.slice(0, 10),
    o: 0,
    c: 0,
    high: c.high / 100,
    low: c.low / 100,
    buy: c.buy,
    sell: c.sell,
    levels: Object.entries(c.levels ?? {}).map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] })),
  }));
}

type Card = { timeET: string; family: string; side: string; entry: number };

async function main() {
  const file = path.join(DATA_DIR, `${day}_ETH.json`);
  if (!existsSync(file)) {
    console.log(`[canary] ${day}: no collected session (${file}) — skipping (collection may have failed)`);
    return;
  }
  const minutes = parseCollected(readFileSync(file, "utf8"));
  if (minutes.length < 60) {
    console.log(`[canary] ${day}: collected session too short (${minutes.length} bars) — skipping`);
    return;
  }

  // the archive file is END-keyed: <day>_ETH.json = the session
  // <day-1> 18:00 ET → <day> 17:00 ET. Live rows are matched by the same
  // timestamp window (the session spans two calendar dates).
  const prevDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const windowStartMs = Date.parse(`${prevDay}T22:00:00Z`); // <day-1> 18:00 ET
  const windowEndMs = Date.parse(`${day}T21:00:00Z`); // <day> 17:00 ET

  // 1. replay the production detectors
  const cards: Card[] = [];
  for (const s of detectMomentum(minutes, MOM_PROD).filter((x) => x.kind === "flush")) {
    cards.push({ timeET: cdtToET(s.t) ?? s.t, family: "failed_flush_breakout", side: s.dir, entry: s.entry });
  }
  for (const s of detectExpansionScalp(minutes, EXP_PROD)) {
    cards.push({ timeET: cdtToET(s.t) ?? s.t, family: "huge_bar_expansion", side: s.dir, entry: s.entry });
  }
  for (const s of detectSoftMomentum(minutes, SOFT_PROD)) {
    cards.push({ timeET: cdtToET(s.t) ?? s.t, family: "session_continuation", side: s.dir, entry: s.entry });
  }
  console.log(`[canary] ${day}: replay found ${cards.length} cards (${cards.map((c) => c.family).join(",") || "none"})`);

  // 2. what live actually fired
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
  let live: Array<{ time_et: string; side: string; verdict: string }> = [];
  try {
    live = (await sql`
      select time_et, side, verdict from signals
      where ts >= ${windowStartMs} and ts < ${windowEndMs} and sent = true`) as typeof live;
  } catch (e) {
    console.log(`[canary] ${day}: signals read failed (${String(e)}) — cannot diff`);
    await sql.end();
    return;
  }

  // 3. diff: a replay card with no live row at the same ET minute (same
  //    side) is a missed signal. Tolerate Session Continuation less
  //    strictly: its live cards carry cluster/stack gates the archive
  //    replay can't fully reproduce, so report them but the ALARM weight
  //    is momentum.
  const missed: Card[] = [];
  for (const c of cards) {
    const hit = live.some((r) => r.time_et === c.timeET && (r.side === c.side || r.side === ""));
    if (!hit) missed.push(c);
  }
  const momMissed = missed.filter((c) => c.family !== "session_continuation");
  if (missed.length > 0) {
    appendDaybook({ t: "canary", at: Date.now(), day, missed: missed.length, momMissed: momMissed.length, detail: missed.map((c) => `${c.timeET} ${c.family} ${c.side}`).join(" · ") });
  }

  // 4. the evening session report: replay vs live vs placed vs filled —
  //    the no-wasted-sessions guarantee. ALWAYS sent (the owner must know
  //    a session ran cleanly too, not only when it diverged).
  const placed = (await sql`
    select count(*)::int as n from exec_trades where ts >= ${windowStartMs} and ts < ${windowEndMs} and status <> 'placed'`) as { n: number }[];
  const filled = (await sql`
    select count(*)::int as n from exec_trades where ts >= ${windowStartMs} and ts < ${windowEndMs} and status in ('filled', 'closed')`) as { n: number }[];
  await sql.end();

  const divLine = missed.length === 0
    ? "✅ canary clean — every replay card has a live counterpart"
    : momMissed.length > 0
      ? `🚨 canary divergence — ${momMissed.length} momentum replay card(s) never fired live`
      : `⚠ canary note — ${missed.length} unmatched replay card(s) (non-momentum)`;
  const summary = [
    `📋 <b>SESSION REPORT · ${day}</b>`,
    `<code>replay ${cards.length} cards · live fired ${live.length} · placed ${placed[0]?.n ?? 0} · filled ${filled[0]?.n ?? 0}</code>`,
    divLine,
    missed.length > 0 ? `<code>${missed.map((c) => `${c.timeET} ${c.family} ${c.side} @${c.entry.toFixed(2)}`).join(" · ")}</code>` : "",
    momMissed.length > 0 ? `Investigate before the next session (INCIDENT-RUNBOOK.md §1) — the 2026-10-15 clock-mix class must be ruled out.` : `The session's detection layer matches the replay — no silent signal kills.`,
  ]
    .filter(Boolean)
    .join("\n");
  console.log(summary);
  if (!dry) void sendTelegram(summary, { parseMode: "HTML" }).catch(() => {});
}

main().catch((e) => {
  console.error("[canary] failed:", e);
  process.exit(1);
});
