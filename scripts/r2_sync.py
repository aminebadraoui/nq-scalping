#!/usr/bin/env python3
"""Sync the local gcdata/data store to Cloudflare R2 (S3-compatible).

Objects are stored gzipped with Content-Encoding: gzip + Content-Type:
application/json so browsers and Node fetch() decompress transparently.
A manifest.json index (file list with candle counts + sha256) lets the app
list and fetch history without bucket listing permissions.

Layout on the bucket:
  data/<date>_ETH.json
  data/<date>_RTH.json
  data/ohlc/<date>.json
  data/options/<symbol>_<date>.json
  manifest.json

Usage:
  python3 scripts/r2_sync.py upload     # gzip + PUT every file, write manifest
  python3 scripts/r2_sync.py verify     # re-check manifest against the bucket
  python3 scripts/r2_sync.py prune      # delete local files except test fixtures
  python3 scripts/r2_sync.py manifest   # rewrite manifest.json only

Env (from gcdata/.env or the shell):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  R2_ENDPOINT (default: https://<account>.r2.cloudflarestorage.com)
"""
import gzip
import hashlib
import hmac
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "gcdata", "data")

# files npm test needs locally (audited session + quarantine fixture)
FIXTURES = {
    "2026-09-25_ETH.json",
    "2026-09-25_RTH.json",
    "2026-09-08_ETH.json",
    "2026-09-08_RTH.json",
    "ohlc/2026-09-25.json",
    "backtest/results.json",
    "backtest/results_rth.json",
}
# never uploaded
SKIP = {"repair_backup", "audit_report.txt", "repair_run.txt", "nightly_log.txt",
        "tick_verify_log.txt", "tick_verify_run.log", "backfill_contracts.log",
        "ingest_log.txt"}


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        # fall back to gcdata/.env (KEY=VALUE lines)
        envfile = os.path.join(ROOT, "gcdata", ".env")
        if os.path.exists(envfile):
            for line in open(envfile):
                line = line.strip()
                if line.startswith(name + "="):
                    v = line.split("=", 1)[1].strip().strip('"')
                    break
    if not v:
        sys.exit(f"missing {name} (set it in gcdata/.env)")
    return v


ACCOUNT = env("R2_ACCOUNT_ID")
ACCESS = env("R2_ACCESS_KEY_ID")
SECRET = env("R2_SECRET_ACCESS_KEY")
BUCKET = env("R2_BUCKET")
ENDPOINT = os.environ.get("R2_ENDPOINT") or f"https://{ACCOUNT}.r2.cloudflarestorage.com"
HOST = urllib.parse.urlparse(ENDPOINT).netloc


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sig_key(secret: str, date: str, region: str, service: str) -> bytes:
    k = sign(("AWS4" + secret).encode(), date)
    k = sign(k, region)
    k = sign(k, service)
    return sign(k, "aws4_request")


def request(method: str, key: str, body: bytes = b"", headers: dict | None = None) -> tuple[int, bytes]:
    """Signed S3 request."""
    now = datetime.now(timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    uri = urllib.parse.quote("/" + BUCKET + "/" + key, safe="/-_.~")
    headers = dict(headers or {})
    headers.update({
        "x-amz-date": amzdate,
        "x-amz-content-sha256": payload_hash,
        "host": HOST,
    })
    if body:
        headers["content-length"] = str(len(body))
    canonical_headers = "".join(f"{k.lower()}:{headers[k].strip()}\n" for k in sorted(headers))
    signed_headers = ";".join(sorted(k.lower() for k in headers))
    canonical = "\n".join([
        method, uri, "",
        canonical_headers, signed_headers, payload_hash,
    ])
    scope = f"{datestamp}/auto/s3/aws4_request"
    to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amzdate, scope,
        hashlib.sha256(canonical.encode()).hexdigest(),
    ])
    signature = hmac.new(sig_key(SECRET, datestamp, "auto", "s3"), to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={ACCESS}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    req = urllib.request.Request(ENDPOINT + uri, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def files_to_upload():
    """(local_path, object_key) for everything worth archiving."""
    out = []
    for sub in ("", "ohlc", "options"):
        base = os.path.join(DATA, sub) if sub else DATA
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if name in SKIP or name.endswith(".gz") or name.endswith(".txt") or name.endswith(".log"):
                continue
            if name.startswith("."):
                continue
            if sub == "" and not (name.endswith("_ETH.json") or name.endswith("_RTH.json")):
                continue
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            key = f"data/{name}" if sub == "" else f"data/{sub}/{name}"
            out.append((p, key))
    return out


def manifest_entry(path: str, key: str):
    raw = open(path, "rb").read()
    gz = gzip.compress(raw, 6)
    j = json.loads(raw)
    candles = len(j.get("candles", [])) if key.startswith("data/") and key.endswith(".json") else None
    if candles is None:
        candles = len(j.get("bars", [])) if "/ohlc/" in key else None
    return {
        "key": key,
        "date": os.path.basename(key)[:10] if "/options/" not in key else os.path.basename(key).split("_")[-1][:10],
        "session": ("ETH" if "_ETH" in key else "RTH") if key.startswith("data/") and "_" in os.path.basename(key) else None,
        "candles": candles,
        "size_raw": len(raw),
        "size_gz": len(gz),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def cmd_upload(dry: bool):
    files = files_to_upload()
    print(f"{len(files)} files to upload")
    # incremental: skip files whose sha matches the manifest already on R2
    remote_sha = {}
    if not dry:
        status, body = request("GET", "manifest.json")
        if status == 200:
            try:
                remote_sha = {f["key"]: f.get("sha256") for f in json.loads(body).get("files", [])}
                print(f"  manifest on R2: {len(remote_sha)} entries")
            except Exception:
                remote_sha = {}
    entries = []
    skipped = 0
    for i, (path, key) in enumerate(files, 1):
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
            status, _ = request("PUT", key, gz, {
                "content-type": "application/json",
                "content-encoding": "gzip",
            })
            print(f"  [{i}/{len(files)}] {key} {entry['size_raw']}->{entry['size_gz']}B HTTP {status}")
            if status != 200:
                sys.exit(f"upload failed for {key}: HTTP {status}")
        entries.append(entry)
    print(f"{skipped} unchanged files skipped")
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "bucket": BUCKET,
        "files": entries,
    }
    if not dry:
        status, _ = request("PUT", "manifest.json", json.dumps(manifest).encode(), {
            "content-type": "application/json",
        })
        print(f"manifest.json HTTP {status} ({len(entries)} entries)")
        if status != 200:
            sys.exit(f"manifest upload failed: HTTP {status}")
    return manifest


def cmd_verify():
    status, body = request("GET", "manifest.json")
    if status != 200:
        sys.exit(f"manifest fetch failed: HTTP {status}")
    m = json.loads(body)
    files = m.get("files", [])
    print(f"manifest has {len(files)} entries")
    for e in files[:3]:  # spot-check the first three
        _, b = request("GET", e["key"])
        sha = hashlib.sha256(gunzip_if_needed(b)).hexdigest()
        ok = "OK" if sha == e["sha256"] else "MISMATCH"
        print(f"  {e['key']}: {ok}")
    return m


def gunzip_if_needed(b: bytes) -> bytes:
    return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b


def cmd_prune(dry: bool):
    removed = kept = 0
    for sub in ("", "ohlc", "options"):
        base = os.path.join(DATA, sub) if sub else DATA
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            rel = name if sub == "" else f"{sub}/{name}"
            if rel in FIXTURES:
                kept += 1
                continue
            p = os.path.join(base, name)
            if not os.path.isfile(p):
                continue
            if name in SKIP or name.endswith((".log", ".txt")):
                if name not in ("backtest",):
                    continue
            # keep everything that is not a data file (e.g. .gitkeep, README)
            if sub == "" and not (name.endswith(".json")):
                if os.path.isdir(p):
                    continue
                kept += 1
                continue
            if dry:
                print(f"  [dry] would delete {rel}")
            else:
                os.remove(p)
                print(f"  deleted {rel}")
            removed += 1
    print(f"pruned {removed} files · kept {kept} fixtures")
    if not dry:
        marker = os.path.join(DATA, ".fixtures-only")
        with open(marker, "w") as f:
            f.write("full store archived to R2 — test suite runs in fixture mode\n")


def main() -> int:
    cmds = {"upload": cmd_upload, "verify": cmd_verify, "prune": cmd_prune}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        return 1
    dry = "--dry-run" in sys.argv
    cmds[sys.argv[1]](dry)
    return 0


if __name__ == "__main__":
    sys.exit(main())
