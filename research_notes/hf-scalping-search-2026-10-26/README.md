# Scalping / slower-trade model search (2026-10-26)

Honest fills (`web/lib/honestFill.ts`) on 875,441 one-minute bars (664 sessions).
Protocol: fit on 2023-12..2024, choose the score threshold on 2025, look at 2026 ONCE.

- `build.mts` — 30 footprint features per bar + honest outcomes of 24 templates
  (limit at the bar POC / one tick beyond the bar extreme / stop breakout × long/short × bracket).
  `BRACKETS`, `HOLD`, `OUT_DIR`, `ARCHIVE_DIR` env vars. Also writes an order-neutral label
  (a bar holding both stop and target counts 50/50) next to the stop-first one.
- `hfmodel.py --dir=<out> [--neutral] [--final]` — gradient-boosted regressor per template.

Results:
- 4–12 pt scalps (`hf_neutral.txt`): every template negative on 2025 even in the top 0.2% of model
  scores, except ones whose "edge" exists only under the order-neutral label (pessimistic −2 to −3 pt).
- 15–25 pt brackets, 90-bar hold (`hf2_*.txt`): 5 short-side candidates positive on 2025;
  on the untouched 2026 holdout (`hf2_final.txt`) 4 of 5 lost; ext_lim_S_20_20 +0.66 pt/trade, PF 1.07
  (463 trades) — consistent with chance.
