"""Shared gcdata/.env loader for the collector and probe scripts.

One implementation instead of nine copy-pasted ones. Semantics:
  * KEY=VALUE lines; blank lines and `#` comments are skipped
  * whitespace around key and value is trimmed, and one pair of matching
    surrounding quotes ("..." or '...') is removed from the value
  * the real environment always wins (os.environ.setdefault) — on the VPS
    the Coolify env is authoritative and the file is only a local fallback
"""
from __future__ import annotations

import os
from pathlib import Path

DEFAULT_ENV = Path(__file__).resolve().parent / ".env"


def parse_env_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    k, v = line.split("=", 1)
    k, v = k.strip(), v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1]
    return (k, v) if k else None


def load_env(path: str | os.PathLike[str] | None = None) -> None:
    p = Path(path) if path is not None else DEFAULT_ENV
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        kv = parse_env_line(line)
        if kv:
            os.environ.setdefault(kv[0], kv[1])
