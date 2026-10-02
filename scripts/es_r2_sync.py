#!/usr/bin/env python3
"""Sync the ES cross-asset archive (gcdata/data/es) to Cloudflare R2.

Deliberately separate from scripts/r2_sync.py: the NQ manifest.json is read by
the dashboard (web/lib/archive.ts, gcdata.ts) and must never see ES keys, so ES
objects live under data/es/ and get their own manifest-es.json.

Usage:
  python3 scripts/es_r2_sync.py upload     # gzip + PUT every es/*.json, write manifest-es.json
  python3 scripts/es_r2_sync.py prune      # delete local es files already archived (sha match)
  python3 scripts/es_r2_sync.py verify     # spot-check the first three objects on R2
  --dry-run with any command
"""
import gzip
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import r2_sync  # noqa: E402  (request(), env(), eth_usable(); reads gcdata/.env)

ROOT = os.path.dirname(HERE)
ES_DATA = os.path.join(ROOT, "gcdata", "data", "es")
MANIFEST_KEY = "manifest-es.json"


def files_to_upload():
    out = []
    if not os.path.isdir(ES_DATA):
        return out
    for name in sorted(os.listdir(ES_DATA)):
        if not (name.endswith("_ETH.json") or name.endswith("_RTH.json")):
            continue
        p = os.path.join(ES_DATA, name)
        if os.path.isfile(p):
            out.append((p, f"data/es/{name}"))
    return out


def manifest_entry(path: str, key: str) -> dict:
    raw = open(path, "rb").read()
    gz = gzip.compress(raw, 6)
    j = json.loads(raw)
    candles = len(j.get("candles", []))
    usable = r2_sync.eth_usable(j.get("candles", [])) if key.endswith("_ETH.json") else None
    return {
        "key": key,
        "date": os.path.basename(key)[:10],
        "session": "ETH" if "_ETH" in key else "RTH",
        "underlying": "ES",
        "candles": candles,
        "usable": usable,
        "size_raw": len(raw),
        "size_gz": len(gz),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def remote_entries() -> tuple[list[dict], dict[str, str]]:
    status, body = r2_sync.request("GET", MANIFEST_KEY)
    if status != 200:
        return [], {}
    try:
        files = json.loads(body).get("files", [])
        return files, {f["key"]: f.get("sha256") for f in files}
    except Exception:
        return [], {}


def cmd_upload(dry: bool):
    files = files_to_upload()
    print(f"{len(files)} ES files to upload")
    remote_files, remote_sha = [], {}
    if not dry:
        remote_files, remote_sha = remote_entries()
        print(f"  {MANIFEST_KEY} on R2: {len(remote_sha)} entries")
    entries, skipped, local_keys = [], 0, set()
    for i, (path, key) in enumerate(files, 1):
        local_keys.add(key)
        entry = manifest_entry(path, key)
        if entry["sha256"] == remote_sha.get(key):
            skipped += 1
            entries.append(entry)
            continue
        raw = open(path, "rb").read()
        gz = gzip.compress(raw, 6)
        if dry:
            print(f"  [dry] {key} ({entry['size_raw']} -> {entry['size_gz']} bytes)")
        else:
            status, _ = r2_sync.request("PUT", key, gz, {
                "content-type": "application/json",
                "content-encoding": "gzip",
            })
            print(f"  [{i}/{len(files)}] {key} {entry['size_raw']}->{entry['size_gz']}B HTTP {status}")
            if status != 200:
                sys.exit(f"upload failed for {key}: HTTP {status}")
        entries.append(entry)
    carried = 0
    for f in remote_files:
        if f.get("key") not in local_keys:
            entries.append(f)
            carried += 1
    print(f"{skipped} unchanged files skipped · {carried} remote-only entries carried over")
    manifest = {
        "generated": r2_sync.datetime.now(r2_sync.timezone.utc).isoformat(),
        "bucket": r2_sync.BUCKET,
        "underlying": "ES",
        "files": entries,
    }
    if not dry:
        status, _ = r2_sync.request("PUT", MANIFEST_KEY, json.dumps(manifest).encode(), {
            "content-type": "application/json",
        })
        print(f"{MANIFEST_KEY} HTTP {status} ({len(entries)} entries)")
        if status != 200:
            sys.exit(f"manifest upload failed: HTTP {status}")
    return manifest


def cmd_prune(dry: bool):
    _, remote_sha = remote_entries()
    removed = kept = 0
    if not os.path.isdir(ES_DATA):
        print("no es dir — nothing to prune")
        return
    for name in sorted(os.listdir(ES_DATA)):
        if not name.endswith(".json"):
            continue
        p = os.path.join(ES_DATA, name)
        if not os.path.isfile(p):
            continue
        sha = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if remote_sha.get(f"data/es/{name}") == sha:
            if dry:
                print(f"  [dry] would delete {name}")
            else:
                os.remove(p)
                print(f"  deleted {name}")
            removed += 1
        else:
            kept += 1
    print(f"pruned {removed} ES files · kept {kept} unarchived")


def cmd_verify(dry: bool = False):
    _, remote_sha = remote_entries()
    keys = sorted(remote_sha)[:3]
    for key in keys:
        status, body = r2_sync.request("GET", key)
        sha = hashlib.sha256(r2_sync.gunzip_if_needed(body)).hexdigest()
        print(f"  {key}: HTTP {status} {'OK' if sha == remote_sha[key] else 'MISMATCH'}")


def main() -> int:
    cmds = {"upload": cmd_upload, "prune": cmd_prune, "verify": cmd_verify}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        return 1
    dry = "--dry-run" in sys.argv
    cmds[sys.argv[1]](dry)
    return 0


if __name__ == "__main__":
    sys.exit(main())
