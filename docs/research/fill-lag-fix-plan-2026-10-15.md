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

### Layer 1 — the fastDispatch backtest (the go/no-go gate)

Replay the three affected families with the fill model a tick-native
dispatch would actually produce: **entry at the true close + ε pts of
adverse drift**, ε ∈ {0, 0.5, 1, 2, 3}, cost 0.5 pt inside P&L, versus
the live limit arms (flushLimit / RTH limit) on the same cards.

- Families: RTH (SOFT_PROD), flush (MOM_PROD), D (first big-bar), and
  the cumD-gated RTH subset.
- Rows: WR, PF, exp pts, per-year, T4 account sim per ε.
- Decision rule: adopt Layer 2/3 only if the ε=1..2 arms clear the
  train gate and beat the live limit arm by a margin that survives the
  per-year table. The flush family's perfect_d1 cell (PF 2.50 → 1.66)
  says the margin exists at ε=1; this study pins ε=1..3 for the other
  families and, critically, the ε distribution itself (Layer 3 supplies
  it).

CLI (scratch, to be written): `web/scripts/fastDispatchStudy.ts`.

### Layer 2 — tick-native bar assembly (the structural fix)

Stop waiting for the vendor's confirmed candle as the detection clock.
Assemble each minute bar locally from the realtime stream:

1. **Aggregate the tick/DOM trade stream per minute** (the vendor's
   realtime footprint stream already updates the forming bar
   continuously; the schema exists — Neon `footprint_ticks`
   (ts, price_cents, buy, sell, buy_trades, sell_trades) — currently
   EMPTY, so this is also the missing `LIVE_WRITE` piece).
2. **Close the bar locally at T+ε** (ε = stream lag, ~1–3 s) — no
   vendor close event needed.
3. **Run the frozen detectors on the tick-assembled bar** at T+ε — same
   code path as the archive replay (`detectMomentum` / `detectSoft-
   Momentum` / `detectExpansionScalp` consume `MomMinute`; the assembler
   emits that shape).
4. **Vendor candle = verification, not clock.** Reconcile tick-assembled
   vs vendor-confirmed bars each minute; alarm on drift (the tape-gate
   ladder stays as the fail-closed safety net; vendor stall episodes
   like the 10-14→15 overnight are already handled by heal + paging).

### Layer 3 — instant limit-at-close dispatch + shadow mode

With the detector running at T+ε:

1. **Place the resting limit at the just-computed close at T+ε** (the
   tape is still at the level → the limit fills at close or better, or
   expires — same bracket machinery as today, just placed 30–55 s
   earlier).
2. **Shadow mode first:** run tick-native detection alongside the
   vendor-candle path for N sessions, journal card-level agreement
   (signal equality, entry/exit deltas, the ε distribution) — this is
   the only honest way to check that our tick aggregation reproduces
   the vendor's buy/sell classification semantics before any live
   switch (classification divergence is the #1 risk; a detector fed
   different buy/sell numbers is a different strategy than the
   backtested one).
3. **Env-gated rollout:** `FAST_DISPATCH=1` per family (RTH / momentum /
   D-forward-log), kill-switchable in one Coolify edit, per
   `web/EXEC_CHANGE_POLICY.md` — backtest tag, tests+types, owner
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
