/* ------------------------------------------------------------------ *
 * RTH winner-exit log — the live side of the counter-signal gate
 * (2026-10-07).
 *
 * The feed's RTH counter-gate skips a card whose entry sits within
 * RTH_COUNTER_GATE_PTS points of an OPPOSITE-side RTH card's WINNING
 * exit in the last RTH_COUNTER_GATE_MIN minutes. That needs live exit
 * awareness: bracket exits are exchange-side, so the system never sees
 * the exit fill directly. execWatch learns exits from the broker:
 * it notes the open position at fill confirmation, and a 30s poll
 * detects the flat transition → the opposite-side session fills since
 * the entry are the exit → win/loss → this ring buffer.
 *
 * Pure decision helpers are unit-tested (tests/rthExitLog.test.ts).
 * Observational input to a veto — it can only ever SKIP a card, never
 * place or change one. Both knobs default to 0 = gate off.
 * ------------------------------------------------------------------ */

export type RthExit = {
  dir: "long" | "short";
  exitPrice: number;
  exitAt: number;
};

const MAX_ENTRIES = 16;
const PRUNE_TTL_MS = 6 * 60 * 60_000;

const g = globalThis as unknown as { __gcRthExits?: RthExit[] };

function mem(): RthExit[] {
  if (!g.__gcRthExits) g.__gcRthExits = [];
  return g.__gcRthExits;
}

export function noteRthExit(dir: "long" | "short", exitPrice: number, exitAt: number): void {
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return;
  const m = mem();
  m.push({ dir, exitPrice, exitAt });
  while (m.length > MAX_ENTRIES) m.shift();
}

export function recentRthExits(now: number, minMs: number): RthExit[] {
  const m = mem();
  for (let i = m.length - 1; i >= 0; i--) {
    if (now - m[i].exitAt > Math.max(minMs, PRUNE_TTL_MS)) m.splice(i, 1);
  }
  return m.filter((e) => now - e.exitAt <= minMs);
}

export type CounterGateDecision = { block: boolean; winner: RthExit | null };

/**
 * Pure gate decision: block a `dir` card entering at `entryPrice` when a
 * recent opposite-side WINNING exit sits within `pts` of the entry.
 * minMs <= 0 or pts <= 0 disables the gate (return {block:false}).
 */
export function counterGateDecision(
  dir: "long" | "short",
  entryPrice: number,
  now: number,
  minMs: number,
  pts: number,
  exits: RthExit[] = recentRthExits(now, minMs),
): CounterGateDecision {
  if (minMs <= 0 || pts <= 0 || !Number.isFinite(entryPrice)) return { block: false, winner: null };
  for (const e of exits) {
    if (e.dir === dir) continue;
    if (Math.abs(entryPrice - e.exitPrice) <= pts) return { block: true, winner: e };
  }
  return { block: false, winner: null };
}

export function counterGateParams(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  minMs: number;
  pts: number;
} {
  const min = Number(env.RTH_COUNTER_GATE_MIN ?? "0");
  const pts = Number(env.RTH_COUNTER_GATE_PTS ?? "0");
  const minMs = Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
  const ptsV = Number.isFinite(pts) && pts > 0 ? pts : 0;
  return { enabled: minMs > 0 && ptsV > 0, minMs, pts: ptsV };
}

export function __resetRthExitLogForTest(): void {
  g.__gcRthExits = [];
}
