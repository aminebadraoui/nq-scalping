#!/usr/bin/env python3
"""Test whether GoCharting serves deeper history under alternate symbol
formats: 4-digit years (NQZ2023), continuous symbols (NQ1!, NQ), and the
current contract asked about old dates. One socket, small batches."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


from envfile import load_env  # noqa: E402  (shared gcdata/.env loader)


def probe(pairs, per_date_timeout=12, batch=4):
    from client import GChartClient, footprint_pb2

    out = {}
    for i in range(0, len(pairs), batch):
        chunk = pairs[i : i + batch]
        try:
            c = GChartClient().connect()
        except Exception as e:
            print(f"  batch connect failed: {e}", flush=True)
            continue
        try:
            for sym, d in chunk:
                c.request_footprint(d, "ETH", symbol=sym)
            for txt, body in c.iter_frames(len(chunk) * per_date_timeout + 15):
                if body is None:
                    continue
                parts = txt.split("~")
                if parts[0] != "FOOTPRINT/V2":
                    continue
                r = footprint_pb2.FootPrintForDateResponse()
                try:
                    r.ParseFromString(body)
                except Exception:
                    continue
                if r.is_complete and r.request and r.request.date:
                    n = len(r.candles)
                    out[(r.request.symbol, r.request.date)] = n
        except Exception:
            pass
        finally:
            try:
                c.close()
            except Exception:
                pass
    return out


def main():
    load_env()
    pairs = [
        # 4-digit year format
        ("NQZ2023", "2023-12-20"),
        ("NQH2023", "2023-02-14"),
        ("NQZ2019", "2019-12-17"),
        # continuous-style symbols
        ("NQ1!", "2023-12-20"),
        ("NQ1!", "2022-06-14"),
        ("NQ", "2023-12-20"),
        # current contract asked about old dates (baseline from before)
        ("NQZ26", "2024-06-14"),
        ("NQZ26", "2023-12-20"),
        # 2-digit boundary re-check on a fresh day
        ("NQZ23", "2023-12-20"),
        ("NQZ23", "2023-11-14"),
        ("NQH24", "2023-12-19"),
        ("NQH24", "2024-01-09"),
    ]
    print(f"symbol-format probe — {len(pairs)} pairs", flush=True)
    got = probe(pairs)
    for sym, d in pairs:
        n = got.get((sym, d))
        status = "NO DATA" if n is None else (f"{n} min COMPLETE" if n >= 1375 else f"sparse {n}")
        print(f"  {sym:<8} {d}  {status}", flush=True)


if __name__ == "__main__":
    main()
