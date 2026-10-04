#!/usr/bin/env python3
"""optuna_view.py — viewer-only Optuna study from an exportSweep.ts JSON.

The TS grid sweep is the search engine; Optuna is NOT the optimizer here.
Every finished config is imported as a completed trial so the Optuna
Dashboard (trial history, parallel coordinates, importance) can explore
the sweep — nothing gets re-searched by Optuna.

Trial value = per-session return-on-risk Sharpe (higher is better);
user_attrs carry n/wr/netUsd so the dashboard tables are readable.

Usage (from gcdata/):
  ./.venv/bin/python optuna_view.py data/sweeps/rth-<stamp>.json \
      [--db data/optuna/rth.db] [--pick s0.45_t1.75_x45]
  ./.venv/bin/optuna-dashboard <db>     # http://127.0.0.1:8080
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import optuna


def sharpe(row: np.ndarray) -> float:
    if row.size < 2 or float(np.ptp(row)) == 0.0:
        return 0.0
    std = float(row.std(ddof=1))
    if std == 0.0 or not np.isfinite(std):
        return 0.0
    return float(row.mean() / std)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sweep", help="path to an exportSweep.ts JSON")
    ap.add_argument("--db", help="sqlite path for the Optuna study")
    ap.add_argument("--pick", help="mark this config id as the pick")
    args = ap.parse_args()

    sweep_path = Path(args.sweep)
    payload = json.loads(sweep_path.read_text())
    family = payload["family"]
    db_path = Path(args.db) if args.db else Path("data/optuna") / f"{family}.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)

    dates = payload["sessions"]
    study = optuna.create_study(
        study_name=family,
        storage=f"sqlite:///{db_path}",
        direction="maximize",
        load_if_exists=True,
    )
    study.set_user_attr("source", sweep_path.name)
    study.set_user_attr("costPts", payload["costPts"])
    study.set_user_attr("nSessions", payload["nSessions"])
    study.set_user_attr("pick", args.pick or "")
    study.set_user_attr(
        "note",
        "viewer-only: trials imported from the TS grid sweep; value = "
        "per-session return-on-risk Sharpe (1 MNQ). Optuna ran no search.",
    )

    n_added = 0
    for cfg in payload["configs"]:
        row = np.array(
            [cfg["perSession"][d]["netUsd"] / cfg["perSession"][d]["riskUsd"]
             if cfg["perSession"][d]["riskUsd"] > 0 else 0.0 for d in dates],
            dtype=float,
        )
        t = cfg["totals"]
        study.add_trial(
            optuna.trial.create_trial(
                params=cfg["params"],
                distributions={
                    "s": optuna.distributions.FloatDistribution(0.25, 1.0),
                    "t": optuna.distributions.FloatDistribution(1.0, 3.0),
                    "x": optuna.distributions.IntDistribution(45, 90),
                },
                value=float(sharpe(row)),
                user_attrs={
                    "id": cfg["id"],
                    "n": t["n"],
                    "wr": round(t["wr"], 4),
                    "netUsd": round(t["netUsd"], 2),
                    "riskUsd": round(t["riskUsd"], 2),
                    "isPick": cfg["id"] == args.pick,
                },
            )
        )
        n_added += 1

    print(f"study '{family}': {n_added} trials imported → {db_path}")
    print(f"dashboard: ./.venv/bin/optuna-dashboard sqlite:///{db_path}   # http://127.0.0.1:8080")
    return 0


if __name__ == "__main__":
    sys.exit(main())
