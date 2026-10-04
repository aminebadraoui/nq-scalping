"use client";

import { useMemo } from "react";
import { useLive } from "@/lib/useLive";
import { computeTickMomentum, type Tick } from "@/lib/tickMomentum";

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "—");
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "—");

function velBar(v: number) {
  const up = Math.round(((v + 1) / 2) * 100);
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-sm border border-zinc-800">
      <div className="bg-long/80" style={{ width: `${up}%` }} />
      <div className="flex-1 bg-short/80" />
    </div>
  );
}

/**
 * Live tick-momentum strip — the objective decode of "the candle is pushing
 * more up than down": velocity asymmetry, leg amplitude, tick intensity,
 * price-impact ratio, probe rejection speed and acceleration, computed from
 * the raw trade tape the feed already ships. Study aid, not an entry signal.
 */
export default function TickMomentumPanel() {
  const live = useLive();
  const m = useMemo(() => {
    const ticks = (live?.ticks ?? []) as Tick[];
    return ticks.length ? computeTickMomentum(ticks) : null;
  }, [live?.ticks]);

  const verdictCls =
    m?.verdict === "pushing up"
      ? "text-long"
      : m?.verdict === "pushing down"
        ? "text-short"
        : m?.verdict === "two-sided"
          ? "text-warn"
          : "text-zinc-500";

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-zinc-50">
          Tick momentum <span className="ml-1 font-mono text-[10px] font-normal text-zinc-500">the speed the footprint hides</span>
        </h2>
        <span className="font-mono text-[10px] text-zinc-500">tape {m ? `${m.n} ticks · ${(m.spanSec).toFixed(1)}s` : "—"} · study aid — not an entry signal</span>
      </div>

      {!m || m.n === 0 ? (
        <p className="font-mono text-[10px] leading-relaxed text-zinc-600">
          waiting for ticks — the live feed only streams while Globex is open (Sun 18:00 → Fri 17:00 NY).
        </p>
      ) : (
        <>
          {/* verdict */}
          <div className="mb-2 flex items-center justify-between rounded border border-zinc-800/70 px-2 py-1.5">
            <span className={`font-mono text-sm font-bold tracking-wide ${verdictCls}`}>
              {m.verdict === "pushing up" && "PUSHING UP ▲"}
              {m.verdict === "pushing down" && "PUSHING DOWN ▼"}
              {m.verdict === "two-sided" && "TWO-SIDED ⇅"}
              {m.verdict === "quiet" && "QUIET ··"}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">push {m.push >= 0 ? "+" : ""}{m.push.toFixed(2)}</span>
          </div>

          {/* velocity — the core decode */}
          <div className="mb-1 grid grid-cols-2 gap-x-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">velocity up/dn</span>
              <span>
                <span className="text-long">{f2(m.upSpeed)}</span>
                <span className="text-zinc-600"> / </span>
                <span className="text-short">{f2(m.downSpeed)}</span>
                <span className="text-zinc-600"> pt/s</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">net</span>
              <span className={m.netVel >= 0 ? "text-long" : "text-short"}>
                {m.netVel >= 0 ? "+" : ""}
                {f1(m.netVel * 60)} pt/min
              </span>
            </div>
          </div>
          <div className="mb-2">{velBar(m.velImb)}</div>

          {/* intensity */}
          <div className="mb-1 grid grid-cols-2 gap-x-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">ticks</span>
              <span className="text-zinc-200">
                {f1(m.ticksPerSec)}/s · {f1(m.contractsPerSec)} ct/s
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">buy/sell vol</span>
              <span>
                <span className="text-long">{m.buyVol}</span>
                <span className="text-zinc-600"> / </span>
                <span className="text-short">{m.sellVol}</span>
              </span>
            </div>
          </div>

          {/* impact λ */}
          <div className="mb-1 grid grid-cols-2 gap-x-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">impact λ buy/sell</span>
              <span>
                <span className="text-long">{f2(m.impactUp)}</span>
                <span className="text-zinc-600"> / </span>
                <span className="text-short">{f2(m.impactDown)}</span>
                <span className="text-zinc-600"> pt/ct</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">λ ratio</span>
              <span className={m.impactRatio >= 1.25 ? "text-long" : m.impactRatio <= 0.8 ? "text-short" : "text-zinc-300"}>
                {m.impactRatio > 0 ? m.impactRatio.toFixed(2) : "—"}
              </span>
            </div>
          </div>

          {/* legs + acceleration */}
          <div className="mb-1 grid grid-cols-2 gap-x-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-zinc-500">leg size up/dn</span>
              <span>
                <span className="text-long">{f2(m.meanUpLeg)}</span>
                <span className="text-zinc-600"> / </span>
                <span className="text-short">{f2(m.meanDownLeg)}</span>
                <span className="text-zinc-600"> pt</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">accel up/dn</span>
              <span>
                <span className={m.accelUp >= 0 ? "text-long" : "text-short"}>{m.accelUp >= 0 ? "+" : ""}{f2(m.accelUp)}</span>
                <span className="text-zinc-600"> / </span>
                <span className={m.accelDown >= 0 ? "text-long" : "text-short"}>{m.accelDown >= 0 ? "+" : ""}{f2(m.accelDown)}</span>
              </span>
            </div>
          </div>

          {/* rejection speed */}
          <div className="mb-1 flex justify-between font-mono text-[11px]">
            <span className="text-zinc-500">reject speed</span>
            <span className="text-zinc-200">
              med {m.medianRecoveryMs > 0 ? `${(m.medianRecoveryMs / 1000).toFixed(1)}s` : "—"} · {f2(m.rejectSpeed)} pt/s
            </span>
          </div>

          {/* recent probes */}
          {m.probes.length > 0 && (
            <div className="space-y-0.5">
              {[...m.probes].reverse().slice(0, 3).map((p, i) => (
                <div key={i} className="flex justify-between font-mono text-[10px] text-zinc-500">
                  <span>
                    <span className={p.dir === "down" ? "text-short" : "text-long"}>{p.dir === "down" ? "▼" : "▲"}</span>{" "}
                    {f2(p.depth)} pt poke
                  </span>
                  <span className={p.answered ? "text-zinc-300" : "text-zinc-600"}>
                    {p.answered ? `answered ${(p.recoveryMs / 1000).toFixed(1)}s · ${f2(p.speed)} pt/s` : "open"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <details className="mt-2 rounded border border-zinc-800/70 px-2 py-1">
            <summary className="cursor-pointer list-none font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
              ▸ what each number means
            </summary>
            <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
              velocity = points moved up vs down per second (the &quot;pushing&quot; feel); net = signed drift, pt/min; ticks =
              trade arrival rate and contracts/sec (intensity); impact λ = points moved per contract of aggressive buying vs
              selling — λ&gt;1 means the same sell pressure moves price less (sellers absorbed); leg size = mean amplitude of
              consecutive same-direction runs; accel = leg size trending bigger (+ = harder pushes); reject speed = how fast a
              ≥0.75pt poke from a local extreme was retraced 50%. windows: 5s metrics, 60s probes. computed from the live
              trade tape (last 2,000 prints) — the archive has no intra-minute time, so these can only be forward-logged,
              not backtested. study aid, not an entry signal.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
