# Wall-aware stops — Pulcini rule, proxy study (2026-10-03)

## The hypothesis (from the Pulcini interview)

"If I see a major GEX level right above where my stop is, why do I want to
stop out knowing there's going to be dealers hedging in that area? So I'll
put my stop above there." — the stop should sit on the FAR side of the
magnet level, not die at it.

## The obstacle: no historical walls

The options collector only started 2026-09 (the `gcdata/data/options` dir is
empty), so no dealer-gamma walls exist for the 649-session archive. Two
deliverables instead:

1. **The live feature** — `web/lib/wallStop.ts` (`applyWallStop`): for a long,
   a put wall within `nearPts` beyond the stop widens it to the far side
   (wall − pad); for a short, the call-wall mirror. Only ever widens, never
   tightens; the target is untouched. 6 unit tests (`tests/wallStop.test.mjs`).
   Wired into `lib/signalFeed.ts` behind `WALL_STOP=1`, applied BEFORE sizing
   so the card's contracts reflect the wider risk; the card prints the note
   ("stop widened … put wall …"). **Default OFF** (see the verdict).
2. **The proxy backtest** — `scripts/wallStopProxyStudy.ts`: the magnet is the
   tape's own concentration level, the trailing 60-bar HVN/POC at entry time,
   run through the SAME `applyWallStop` function. It measures the PLACEMENT
   RULE against 6,961 momentum+expansion trades (649 sessions, sequential,
   pessimistic same-bar stop-first, 0.5 pt cost, 60-bar exit).

## The anatomy — how often does a stop sit at the magnet?

| Magnet within | share of trades | of those stopped | baseline stop-rate |
|---|---|---|---|
| ≤5 pt beyond stop | 23.5% | 21% | 23.0% |
| ≤10 pt | 35.3% | 23% | 23.0% |
| ≤15 pt | 42.0% | 22% | 23.0% |

**Finding: the magnet does NOT concentrate stops.** Trades with a trailing-POC
magnet just beyond the stop stop out at the same ~23% rate as everyone else.
On this tape, the trailing POC is not the stop-run magnet the dealer-wall
story predicts (the trailing POC sits near the entry by construction — a real
gamma wall is usually farther away, so this proxy is imperfect in exactly the
direction that matters).

## The variants (all archive vs test ≥ 2026-01-01)

| Variant | mom WR/PF/expR | exp WR/PF/expR | $ total | worst day |
|---|---|---|---|---|
| baseline (prod stops) | 75.3% / 2.68 / +0.393 | 77.7% / 3.02 / +0.447 | $494,990 | −$691 |
| widen beyond magnet ≤5pt | 76.4% / 2.56 / +0.352 | 78.7% / 2.94 / +0.410 | $447,830 | −$713 |
| widen beyond magnet ≤10pt | 77.7% / 2.44 / +0.316 | 79.8% / 2.81 / +0.381 | $409,775 | −$688 |
| widen beyond magnet ≤15pt | 78.6% / 2.38 / +0.294 | 80.6% / 2.79 / +0.360 | $383,978 | −$688 |
| skip when magnet ≤5pt | 74.4% / 2.58 / +0.377 | 77.3% / 3.01 / +0.442 | $371,665 | −$802 |
| skip when magnet ≤10pt | 74.0% / 2.55 / +0.371 | 77.8% / 3.12 / +0.452 | $318,867 | −$785 |

All variants PASS the eval sim — because they keep ~99% of the same trade
flow. The point is the direction: **widening raises the win rate and lowers
everything else** — PF, expR, dollar total, and the test-period expR degrade
monotonically as the widen radius grows. The 1,549 ≤5pt-widened trades: 83%
"win after widen" — but the wins get smaller and the 257 that still stop lose
MORE (bigger stop), which is why the total falls. Skipping near-magnet trades
also loses money (removing 23–35% of trades never pays for the ~1% stop-rate
improvement).

## Verdict

**REJECT automatic widening.** With the trailing-POC magnet, the rule behaves
exactly like the generic stop-widening the pad sweep already rejected
(`context-veto-stoprun-2026-10-02.md`): more winners, smaller edge,
worse tail per dollar. The anatomy explains why: the magnet isn't a stop
magnet on this tape.

**Ship the note, not the widen.** The live feature stays behind `WALL_STOP=1`
(default off). When historical gamma walls exist (after a few months of
options collection), re-run this study with REAL walls — the code is already
generic over the wall source, and the dealer-wall hypothesis deserves that
test before the feature is written off. In the meantime the card can carry
the wall distance as context (the options box already prints the walls as
location), which is free.

Caveats: the magnet proxy is the trailing HVN — imperfect (see above); widened
trades were rescored on the same sequential flow, so overlaps shift by a bar
or two in edge cases.
