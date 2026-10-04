# Regression tests

```bash
npm test          # 427 tests (420 pass, 7 skipped), offline (~2.5 s)
npm run test:watch
```

The suite exists because the numbers on the dashboard are the product: a silent
change in a bucketing rule, a timezone offset or an event threshold is a wrong
number in front of a trade. Every test either **recomputes the rule a second
time** (independent implementation in `helpers.mjs`) or **pins a golden value**
captured from the audited session `2026-09-25`.

## Why the tests import the real modules

`tests/ts-loader.mjs` registers a resolver hook so Node can import the app's
TypeScript directly (`lib/gcdata.ts` imports `./imbalance` without an
extension). The tests therefore exercise **the shipping code**, not a copy of
it. Nothing in `helpers.mjs` imports the engine — that is what makes the
comparisons meaningful.

## What is covered

| File | Checks |
|---|---|
| `profiles.test.mjs` | bucketing / POC / 70% value area / LVN zones vs an independent recomputation at 1, 2 and 4-tick rows; VA ≥ 70% **and minimal**; POC is the max row; no volume lost or double-counted; zone ordering and ≥ 1 pt width; the opening-range reference; the six-profile level sheet |
| `analysis.test.mjs` | session VWAP (independent HLC3); windowed VWAP ≠ session VWAP; **every** qualifying divergence pair is reported (D2/D4) with its condition re-verified; reclaims incl. one-tick breaks; initiative (aggression **and** a strict new extreme); absorption recomputed from the documented rule; LVN enter/exit crossings; per-alert `vwapSide`; pinned alert and imbalance counts |
| `imbalance.test.mjs` | 3:1 and 10-contract boundaries, zero-side rows, neighbour requirements, stack runs (longest wins, breaks reset), every real stack is a maximal run, full-session sweep (26 k rows) with **0** flag mismatches, degenerate inputs |
| `story.test.mjs` | classifier fixtures for climax up/down, quiet retest, vacuum, rotation; the "big bar without a new extreme is not initiative" regression; real-session state histogram, transitions, POC trail, delta flip, effort/result; narrative times go through the formatter |
| `mechanism.test.mjs` | complete long/short sequences; absorption ageing (yes / partial / no); the missing-absorption invalidation text; empty and NaN windows never leak `∞`/`NaN`; ties do not silently resolve long; stale stacks still give a side; `missing` matches the ingredient states; golden read of the audited session |
| `times.test.mjs` | feed→NY is +1 h and round-trips; `utcToET` DST-aware (EDT vs EST); the two one-hour windows per year where Chicago and New York are 2 h apart in UTC; session boundaries in both seasons; `etToEpoch` vs Intl incl. DST days |
| `ohlc.test.mjs` | every OHLC file structurally valid and sorted; every complete session **that has an OHLC twin** has a full 390-bar RTH file + 1 380-bar ETH twin (twins exist for the recent `collect_ohlc` window only); the OHLC↔footprint join is **exact** (price and volume) over 3 900 minutes; price scaling; the full-day window maps to 1 380 contiguous minutes across midnight (18:00 → 16:59 New York) |
| `parity.test.mjs` | the Python engine (`gcdata/profiles.py`) and the TypeScript engine produce identical level sheets — network test, opt-in via `PARITY_NET=1` (skips otherwise) |
| `api.test.mjs` | optional: with the dev server up, `/api/gc` returns exactly what the modules return, and all three session windows have the documented bar counts. Skips silently when no server is reachable, so `npm test` works offline |

## Adding a test

1. If the change touches a number, add an **invariant** (something that must
   hold whatever the data is) before a golden value.
2. Golden values must come from a session that was independently verified —
   state the date and what was audited in the test name.
3. Never import `lib/*` into `helpers.mjs`: a shared import would let a bug
   make its own test pass.
