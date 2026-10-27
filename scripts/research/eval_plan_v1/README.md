# Eval plan v1 — the study behind `web/lib/evalPlan.ts`

Run from this folder with the session archive loaded into `sessions.npz`
(`research_notes/honest-fill-search-2026-10-26/load.py`):

```bash
python3 anomalies.py        # gap fade (+ the other clock-based anomalies)
python3 intraday_trend.py   # noise-area momentum + ORB variants
python3 portfolio.py        # daily risk-adjusted returns per year, correlations
python3 evalport2.py        # MFF 50K Rapid EOD rolling-start pass/breach by size
```

`evalparity.mts` replays the archive through the LIVE decision module
(`web/lib/evalPlan.ts`): gap decisions match the Python study on 662/662
sessions, first noise-area entries on 660/662.

Result: noise area + gap fade (stop ≤ 150 pt), 1 MNQ each — historical
rolling starts 2024/2025: ~100% pass, 0% breach (median 104–148 trading
days); block-bootstrap: 90% pass / 9% breach; with a $10/day lower edge:
56% / 35%. Larger size raises the breach rate sharply.
