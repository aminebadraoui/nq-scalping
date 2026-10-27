# Honest-fill strategy search (2026-10-26)

Report: `docs/research/honest-fills-2026-10-26.md`.

- `sim.py` — Python mirror of `web/lib/honestFill.ts` (`parity.py` checks it against the TS module).
- `load.py` — archive cache → `sessions.npz` (`ARCHIVE_DIR`, default `~/.cache/nq-archive`).
- `search.py` — 8 volume/price families, 752 configs, honest fills (`p80` market estimate by default).
- `analyze.py` — train (< 2026-01-01) selection, DSR over all trials, PBO (CSCV, 16 blocks), 2026 holdout.
- `analysis_p80.txt` — the run behind the report; `analysis_p50.txt` — the earlier 5-family run with the
  optimistic p50 estimate (kept to show the divergence-fade artifact).

Outputs (`sessions.npz`, `results_*.pkl`, `analysis_*.json`) are written to `WORK_DIR` (default: this folder) and are not committed.
