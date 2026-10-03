/* ------------------------------------------------------------------ *
 * Runner ladder tracker — the LIVE counterpart of the ladder engine
 * in runner.ts (scoreRunner). For every open runner leg of a
 * scale-out, it watches the feed's completed minutes and moves the
 * stop up the ladder via CrossTrade CHANGE orders:
 *
 *   at +1R → stop to breakeven
 *   at +2R → stop to +1R
 *   at +3R → stop to +2R   (… every rung)
 *
 * The rung math is the same pessimistic bar-based rule as the
 * backtest (rung = floor(favorable excursion / risk), per completed
 * minute), so live management and backtest stay on the same page.
 *
 * State is held in memory + snapshotted to a JSON file on every
 * transition (RUNNER_STATE_FILE, default .runner-state.json) so a
 * process restart can re-attach to open runners. The exchange-side
 * stop remains the backstop at all times: if this process dies, the
 * last moved stop is still resting at Tradovate.
 *
 * No polling is added: signalFeed's existing 30-second tick calls
 * evaluate() with the same completed minutes the detectors use.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import path from "node:path";
import { changeCrossTradeOrder } from "./crossTrade";

export type RunnerState = {
  id: string;
  bankOrderId: string | null;
  runnerOrderId: string;
  dir: 1 | -1;
  entry: number;
  stop0: number;
  risk: number;
  contracts: number;
  runnerQty: number;
  lockedRungs: number; // 0 = initial stop · 1 = BE · 2 = +1R · …
  entryTimeET: string;
  createdAt: string;
  updatedAt?: string;
};

export type RungAction =
  | { move: "none" }
  | { move: "stop"; rung: number; stopPrice: number }
  | { move: "done"; why: "stop-touched" | "time-exit" };

/** Pure ladder transition — mirrors scoreRunner's per-bar logic. */
export function nextRungAction(s: RunnerState, high: number, low: number, maxBars = 60, entryBarAge = -1): RungAction {
  const dir = s.dir;
  const currentStop =
    s.lockedRungs === 0 ? s.stop0 : s.entry + dir * (s.lockedRungs - 1) * s.risk;
  const stopTouched = dir > 0 ? low <= currentStop : high >= currentStop;
  if (stopTouched) return { move: "done", why: "stop-touched" };
  if (entryBarAge >= maxBars) return { move: "done", why: "time-exit" };

  const fav = dir > 0 ? high - s.entry : s.entry - low;
  const rung = fav > 0 ? Math.floor(fav / s.risk) : 0;
  if (rung <= s.lockedRungs) return { move: "none" };

  // ladder: at rung n the stop sits at (n−1)R  (rung 1 → breakeven)
  const stopPrice = s.entry + dir * (rung - 1) * s.risk;
  const beyond = dir > 0 ? stopPrice > currentStop : stopPrice < currentStop;
  return beyond ? { move: "stop", rung, stopPrice } : { move: "none" };
}

function snapshotFile(): string {
  return process.env.RUNNER_STATE_FILE || path.join(process.cwd(), ".runner-state.json");
}

class RunnerTracker {
  private states = new Map<string, RunnerState>();
  private loaded = false;

  /** re-attach to runners left open by a previous process */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(snapshotFile(), "utf8")) as { states?: RunnerState[] };
      for (const s of raw.states ?? []) {
        if (s?.id && s.runnerOrderId && Number.isFinite(s.entry) && Number.isFinite(s.risk)) {
          this.states.set(s.id, s);
        }
      }
      if (this.states.size) console.log(`[runnerTracker] re-attached ${this.states.size} runner(s) from snapshot`);
    } catch {
      /* no snapshot yet */
    }
  }

  register(s: RunnerState): void {
    this.states.set(s.id, s);
    console.log(
      `[runnerTracker] registered ${s.dir > 0 ? "LONG" : "SHORT"} runner ${s.runnerQty} MNQ ` +
        `entry ${s.entry.toFixed(2)} stop0 ${s.stop0.toFixed(2)} (order ${s.runnerOrderId})`,
    );
    void this.persist().catch(() => {});
  }

  list(): RunnerState[] {
    return [...this.states.values()];
  }

  private async persist(): Promise<void> {
    try {
      const tmp = snapshotFile() + ".tmp";
      await fs.writeFile(tmp, JSON.stringify({ states: this.list() }, null, 2));
      await fs.rename(tmp, snapshotFile());
    } catch (e) {
      console.warn(`[runnerTracker] snapshot write failed: ${String(e)}`);
    }
  }

  /** Called from the feed's tick with the completed minutes. Fires CHANGE
   *  orders for every rung crossed since the last evaluation. */
  async evaluate(minutes: { high: number; low: number }[]): Promise<void> {
    if (!this.states.size || !minutes.length) return;
    const last = minutes[minutes.length - 1];
    for (const s of this.list()) {
      const action = nextRungAction(s, last.high, last.low);
      if (action.move === "none") continue;
      if (action.move === "done") {
        this.states.delete(s.id);
        void this.persist().catch(() => {});
        if (action.why === "time-exit") {
          console.warn(`[runnerTracker] ${s.id} TIME EXIT — flatten the runner manually (order ${s.runnerOrderId})`);
        } else {
          console.log(`[runnerTracker] ${s.id} stopped out exchange-side — cleared`);
        }
        continue;
      }
      // move the stop up the ladder
      const res = await changeCrossTradeOrder({ orderId: s.runnerOrderId, stopPrice: action.stopPrice });
      if (res.ok) {
        s.lockedRungs = action.rung;
        s.updatedAt = new Date().toISOString();
        void this.persist().catch(() => {});
        console.log(
          `[runnerTracker] ${s.id} rung ${action.rung} → stop ${action.stopPrice.toFixed(2)} ` +
            `(${action.rung === 1 ? "breakeven" : `+${action.rung - 1}R`}) · ${res.reason}`,
        );
      } else {
        console.warn(`[runnerTracker] ${s.id} rung ${action.rung} CHANGE failed: ${res.reason}`);
      }
    }
  }
}

/** feed-wide singleton — one tracker, one snapshot, both feed paths share it */
export const runnerTracker = new RunnerTracker();
