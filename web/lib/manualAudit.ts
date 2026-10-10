/* ------------------------------------------------------------------ *
 * Manual-trade audit — cross-reference every manual trip with ALL
 * recorded signals and label it.
 *
 * "Manual" is currently a RESIDUAL: any round trip no signal explains.
 * This module turns the residual into a labeled, evidenced decision:
 *
 *   · BOT       — the trip already corrects a bot trade (matched_signal)
 *   · BOT-SUSPECT — a signal matches STRICTLY (same day+side,
 *                   |Δt| ≤ 3 min, |Δqty| ≤ 2, |Δentry| ≤ 2 pts) but the
 *                   trip wasn't paired — likely a bot trade whose card
 *                   or pairing failed;
 *   · AMBIGUOUS — a signal exists within the wide window (15 min) but
 *                 outside the strict tolerances, or several signals
 *                 match strictly — needs a human look;
 *   · MANUAL     — no same-side signal within 15 min: a real manual
 *                 trade (or a bot trade with NO card at all — the
 *                 audit can't invent evidence it doesn't have).
 *
 * Evidence travels with every label (nearest signal, Δt/Δpx/Δqty) so
 * the journal can show WHY a trip is labeled what it is.
 * Pure + unit-tested.
 * ------------------------------------------------------------------ */

export type ManualTrip = {
  key: string;
  day: string;
  direction: "long" | "short";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryAtMs: number;
  matchedSignal: string | null;
};

export type SignalRef = {
  key: string;
  day: string;
  ts: number; // epoch ms (the card's fire time)
  side: "long" | "short";
  contracts: number;
  entry: number | null; // signal entry price (null = unparseable)
};

export type TripLabel = "bot" | "bot-suspect" | "ambiguous" | "manual";

export type TripEvidence = {
  label: TripLabel;
  reason: string;
  /** the nearest candidate signal's key (null when none exists) */
  nearestSignal: string | null;
  dtMin: number | null;
  dPx: number | null;
  dQty: number | null;
  strictCandidates: number;
  wideCandidates: number;
};

export const STRICT_DT_MIN = 3;
export const STRICT_DQTY = 2;
export const STRICT_DPX = 2.0;
export const WIDE_DT_MIN = 15;

export function signalContracts(sig: SignalRef): number {
  return sig.contracts > 0 ? sig.contracts : 0;
}

/** nearest same-day/same-side signal by |Δt| within the wide window */
function nearest(sigs: SignalRef[], trip: ManualTrip): { sig: SignalRef; dtMin: number } | null {
  let best: { sig: SignalRef; dtMin: number } | null = null;
  for (const s of sigs) {
    if (s.day !== trip.day || s.side !== trip.direction) continue;
    const dt = Math.abs(s.ts - trip.entryAtMs) / 60_000;
    if (dt > WIDE_DT_MIN) continue;
    if (!best || dt < best.dtMin) best = { sig: s, dtMin: dt };
  }
  return best;
}

/** label one manual trip against the full signal set */
export function auditTrip(trip: ManualTrip, signals: SignalRef[]): TripEvidence {
  if (trip.matchedSignal) {
    return {
      label: "bot",
      reason: "corrects a bot trade (matched_signal set)",
      nearestSignal: trip.matchedSignal,
      dtMin: null,
      dPx: null,
      dQty: null,
      strictCandidates: 0,
      wideCandidates: 0,
    };
  }

  const same = signals.filter((s) => s.day === trip.day && s.side === trip.direction);
  const strict = same.filter((s) => {
    const dt = Math.abs(s.ts - trip.entryAtMs) / 60_000;
    if (dt > STRICT_DT_MIN) return false;
    if (signalContracts(s) > 0 && Math.abs(signalContracts(s) - trip.qty) > STRICT_DQTY) return false;
    if (s.entry !== null && Math.abs(s.entry - trip.entryPrice) > STRICT_DPX) return false;
    return true;
  });

  const near = nearest(signals, trip);

  if (strict.length >= 1) {
    const s = strict[0];
    const dt = Math.abs(s.ts - trip.entryAtMs) / 60_000;
    return {
      label: strict.length > 1 ? "ambiguous" : "bot-suspect",
      reason:
        strict.length > 1
          ? `${strict.length} signals match strictly — needs a human look`
          : "a signal matches strictly (time+qty+price) but was never paired — likely a bot trade that lost its card",
      nearestSignal: s.key,
      dtMin: Math.round(dt * 100) / 100,
      dPx: s.entry !== null ? Math.round((s.entry - trip.entryPrice) * 100) / 100 : null,
      dQty: signalContracts(s) > 0 ? trip.qty - signalContracts(s) : null,
      strictCandidates: strict.length,
      wideCandidates: near ? 1 : 0,
    };
  }

  if (near) {
    const s = near.sig;
    const dt = near.dtMin;
    return {
      label: "ambiguous",
      reason: "a same-side signal sits within 15 min but outside the strict tolerances",
      nearestSignal: s.key,
      dtMin: Math.round(dt * 100) / 100,
      dPx: s.entry !== null ? Math.round((s.entry - trip.entryPrice) * 100) / 100 : null,
      dQty: signalContracts(s) > 0 ? trip.qty - signalContracts(s) : null,
      strictCandidates: 0,
      wideCandidates: 1,
    };
  }

  return {
    label: "manual",
    reason: "no same-side signal within 15 min — a real manual trade (or a bot trade with no card at all)",
    nearestSignal: null,
    dtMin: null,
    dPx: null,
    dQty: null,
    strictCandidates: 0,
    wideCandidates: 0,
  };
}

/** label every trip; returns the trips annotated with evidence */
export function auditManualTrips(
  trips: ManualTrip[],
  signals: SignalRef[],
): Array<ManualTrip & { evidence: TripEvidence }> {
  return trips.map((t) => ({ ...t, evidence: auditTrip(t, signals) }));
}

export type AuditSummary = Record<TripLabel, number>;

export function auditSummary(labeled: Array<{ evidence: TripEvidence }>): AuditSummary {
  const out: AuditSummary = { bot: 0, "bot-suspect": 0, ambiguous: 0, manual: 0 };
  for (const t of labeled) out[t.evidence.label]++;
  return out;
}
