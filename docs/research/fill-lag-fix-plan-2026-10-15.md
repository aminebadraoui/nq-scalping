# Fixing the fill wall — tick-native bar close + instant limit dispatch (2026-10-15)

> Question: *"Every family that needs a marketable entry hits the same wall —
> C collapses PF 3.71 → 1.13 on dispatch-tape fills and 1.05 on limit fills;
> D's edge shrinks to a third under limits. The edge lives in the one bar
> after the signal, and the vendor's 32–57 s confirmation lag makes it
> structurally unreachable at dispatch. How do we fix this?"*
> Plan doc — nothing applied. All code changes below are proposals that
> follow `web/EXEC_CHANGE_POLICY.md` (backtest → `[backtested:]` → tests →
> explicit owner approval).

## 1. The diagnosis, stated precisely

The measured ladder (flush family, momentumEntryMechanics; RTH family,
rthLimitFillDrift + reverse-engineered-patterns):

| fill model | flush (PF) | RTH gated (PF) | why |
|---|---|---|---|
| **at the signal close** (the edge) | 2.50 | 3.71 | the next bar contains the move |
| close + 1 pt adverse | 1.66 | unmeasured | the edge decays ~40%/pt |
| resting limit at close, placed LIVE (32–57 s late) | 1.27–1.55 | ~1.05–1.49 | by placement time the tape has left the level → no-fill or adverse-information fill |
| marketable at dispatch (bar+1 tape) | 0.64 | 1.13 | one full bar of chase = the edge is gone |

**The limit family is the right mechanism placed at the wrong time.** A
resting limit at the close fills at the close or better — but only if it
exists when the tape is still there. Today it is placed 32–57 s after the
close (the vendor's candle-confirmation cadence), so it fills only when
price comes back (adverse) or never (trend days). The wall is not the
strategy, not the bracket, not the order type — **it is a 30–55-second
clock error between the signal bar's true close and when the system is
told the bar closed.**

The live system already knows this in one place: the tape gate's
`barSource` shows tick-assembled bars (`{candle: 117, tick: 3}`) — the
tick path exists and releases cards when candle confirmation stalls
(tick-fire fallback, `c722acb`). It just isn't the primary clock for
signal detection.

## 2. The fix — three layers, each gated by its own evidence

### Layer 1 — the fastDispatch backtest (the go/no-go gate) — DONE, PASSED

> **Design correction vs the original plan:** with resting-limit entries,
> the honest lag model is *placement* lag (which bar the limit exists
> from), not a uniform ε-pt price drift on a marketable fill. Shipped
> study: `web/scripts/fastDispatchStudy.ts` —
> `docs/research/fast-dispatch-2026-10-15.md`.

The placement-lag ladder over the full archive (656 sessions, train/test,
live limit brackets frozen, TTL 9):

| family | lag0 (fast-confirm target) | lag1 (live proxy, ~40 s late) | recovered |
|---|---|---|---|
| flush (MOM_PROD) | 1,327 t · PF 1.22 · +0.50 pts | 1,280 t · PF 1.15 · +0.35 pts | **+210.9 net pts** |
| rth (SOFT_PROD, ungated bracket) | 2,657 t · PF 1.07 · +0.23 | 2,563 t · PF 1.03 · +0.10 | **+335.2 net pts** |
| d100 (first big-bar) | 96 t · PF 1.38 · +4.26 | 91 t · PF 1.29 · +3.36 | **+103.1 net pts** |

Decision: **adopt** — every family gains, the decay is monotonic with
lag on the flush family, and the fix is fail-closed by construction (the
card gate still requires a candle-source bar). The study also falsifies
the hope that fast dispatch unlocks the idealized close-fill edge: the
lag0 arm IS the validated limit arm — the harvest is recovered
placement-lag bleed, nothing more.

### Layer 2 — the confirm race: vendor REST for the just-closed candle (SHIPPED 2026-10-15)

> **Design correction vs the original plan:** "tick-native bar assembly"
> was rejected during implementation — the repo's own F1 history shows the
> tick stream carries only ~7–50% of true volume, so a locally tick-closed
> bar feeds the frozen detectors a thinner tape than the backtest (the
> exact disease F1 cured). The correct mechanism closes the SAME vendor
> candle earlier instead of assembling a different one: race the vendor's
> **REST** endpoint for the just-closed minute, which publishes the
> confirmed candle in **~7.5 s** (measured by `CONFIRM_RACE_PROBE`)
> versus 32–57 s on the frame channel.

Shipped in `e1becf9` (`web/lib/live.ts`):

1. After each completed minute (tail is tick-source), poll
   `fetchFootprintBars` (the same vendor REST the 60 s refresh uses)
   every **1.5 s for ≤12 s**, reusing the cached token — no fresh
   Cognito auths (the lockout risk), no new data semantics: the merged
   bar is byte-compatible with the archive the backtests were computed
   on.
2. The first poll that returns the confirmed candle merges it through
   the idempotent `mergeCandleMinutes` path and the card gate releases
   on it — **the gate still requires a candle-source bar, so a failed
   race holds cards exactly like today; it can never fail open.**
3. `FAST_DISPATCH=0` (default) = today's behavior, zero change;
   `CONFIRM_RACE_PROBE=1` = measurement mode (timing logs only).
4. `/health` → `confirmRace` {fastDispatch, active, races, restWins,
   frameWins, lastRestConfirmMs, lastFrameConfirmMs} — the real per-bar
   latency is a monitored number before any sizing claim.

### Layer 3 — instant limit-at-close dispatch + shadow mode

With the candle confirmed at ~T+7.5 s, the existing card flow dispatches
the resting limit **at the signal close** ~25–50 s earlier — the bracket
machinery is unchanged (flushLimit / RTH limit rest at the close today);
only the placement time moves. No new entry mechanics.

1. **Shadow mode first:** `CONFIRM_RACE_PROBE=1` journals the REST-vs-
   frame race per bar (`confirmRace` counters) without changing any
   dispatch — the honest check that the observed REST latency matches
   the ~7.5 s assumption before flipping.
2. **Env-gated rollout:** `FAST_DISPATCH=1` arms the production race;
   kill-switch = set it back to `0`, one Coolify edit, per
   `web/EXEC_CHANGE_POLICY.md` — backtest tag (`[backtested:
   scripts/fastDispatchStudy.ts --offline]`), tests+types, owner
   approval, one behavior change per deploy.

## 3. Why this can work — the evidence already in the repo

- **The fast path exists:** the 01:45 card filled in 47 ms through
  CrossTrade REST — order placement is not the bottleneck.
- **The tick machinery exists:** tape-gate tick-fire fallback (live),
  `barSource {candle, tick}` counters (live), `footprint_ticks` schema
  (empty — needs the writer), `tickMomentum` velocity/impact decode
  (study aid, ready to reuse).
- **The ceiling is measured:** flush perfect arm PF 2.50 / RTH close
  fill PF 3.71 — the close-fill edge is the single biggest untapped
  number in the repo, and ε=1 keeps ~⅔ of it (perfect_d1 PF 1.66).
- **The wall is uniform:** the same lag explains the flush chase bleed,
  the RTH no-fills, the crash-day zero, and the reverse-engineered
  families' collapse. One fix addresses all of them.

## 4. Risks and mitigations

| risk | mitigation |
|---|---|
| tick aggregation's buy/sell classification ≠ vendor semantics → detector drift vs backtest | shadow reconciliation (§2.3), per-card agreement metric, alarm on divergence before any live switch |
| vendor stream stalls (the 10-14→15 episodes) | tick path inherits the tape gate + heal ladder; candle path remains the fallback clock |
| ε not 1–3 s but 10+ s on bad mornings | Layer 1 measures the penalty per ε; Layer 3 journals the live ε distribution before sizing the claim |
| same-bar stop/target ambiguity | unchanged: pessimistic stop-first, engine standard |
| new exec surface = new bug surface (the 10-15 veto lesson) | one behavior change per deploy, env kill-switch, post-deploy verification, contract-level clock tests |

## 5. The decision ladder (what to do in order)

1. `fastDispatchStudy.ts` — prove the ε=1..2 arms beat the limit arms
   with the standard report (T1/T2/T4/verdict). If not: stop, the
   harvest doesn't exist.
2. Tick writer → `footprint_ticks` (data layer, no behavior change).
3. Shadow reconciliation run (N sessions, journal-only).
4. `FAST_DISPATCH=1` proposal with the study tag + owner approval.

*Educational research only — not financial advice.*
