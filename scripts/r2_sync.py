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

# files npm test needs locally (audited session + quarantine + the previous
# sessions that feed the P4 prev-day and P5 composite sheets of the golden test)
FIXTURES = {
    "2026-09-25_ETH.json",
    "2026-09-25_RTH.json",
    "2026-09-08_ETH.json",
    "2026-09-08_RTH.json",
    "2026-09-24_RTH.json",
    "2026-09-23_RTH.json",
    "2026-09-22_RTH.json",
    "2026-09-21_RTH.json",
    "2026-09-18_RTH.json",
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


def request(method: str, key: str, body: bytes = b"", headers: dict | None = None, query: str = "") -> tuple[int, bytes]:
    """Signed S3 request (query = raw query string, e.g. 'list-type=2&prefix=data/')."""
    now = datetime.now(timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    uri = urllib.parse.quote("/" + BUCKET + "/" + key, safe="/-_.~")
    if query:
        uri += "?" + query
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


def contiguous(ts: list[str]) -> bool:
    """Minutes-consecutive check without datetime parsing (same as repair_data.py)."""
    if not ts:
        return False
    s = sorted(ts)

    def key(t: str):
        return (int(t[0:4]) * 372 + int(t[5:7]) * 31 + int(t[8:10]), int(t[11:13]) * 60 + int(t[14:16]))

    prev = key(s[0])
    for t in s[1:]:
        cur = key(t)
        if cur[0] == prev[0] and cur[1] == prev[1] + 1:
            prev = cur
            continue
        if cur[0] == prev[0] + 1 and prev[1] == 24 * 60 - 1 and cur[1] == 0:
            prev = cur
            continue
        return False
    return True


def eth_usable(candles: list) -> bool:
    """Mirror of web/lib/lab.ts sessionUsable: contiguous, correct session
    window (17:00..17:15 feed-clock open, 15:59 close), >= 1360 minutes."""
    if not candles or len(candles) < 1360:
        return False
    ts = [c["t"] for c in candles]
    if not contiguous(ts):
        return False
    s = sorted(ts)
    first = int(s[0][11:13]) * 60 + int(s[0][14:16])
    last = int(s[-1][11:13]) * 60 + int(s[-1][14:16])
    return 1020 <= first <= 1035 and last == 959


def manifest_entry(path: str, key: str):
    raw = open(path, "rb").read()
    gz = gzip.compress(raw, 6)
    j = json.loads(raw)
    candles = len(j.get("candles", [])) if key.startswith("data/") and key.endswith(".json") else None
    if candles is None:
        candles = len(j.get("bars", [])) if "/ohlc/" in key else None
    usable = None
    if key.startswith("data/") and key.endswith("_ETH.json") and not key.startswith("data/ohlc"):
        usable = eth_usable(j.get("candles", []))
    return {
        "key": key,
        "date": os.path.basename(key)[:10] if "/options/" not in key else os.path.basename(key).split("_")[-1][:10],
        "session": ("ETH" if "_ETH" in key else "RTH") if key.startswith("data/") and "_" in os.path.basename(key) else None,
        "candles": candles,
        "usable": usable,
        "size_raw": len(raw),
        "size_gz": len(gz),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def cmd_upload(dry: bool):
    files = files_to_upload()
    print(f"{len(files)} files to upload")
    # incremental: skip files whose sha matches the manifest already on R2,
    # and CARRY OVER remote-only entries — the archive lives on R2, not the
    # local disk, so the manifest must keep every object it has ever seen
    remote_files: list[dict] = []
    remote_sha: dict[str, str] = {}
    if not dry:
        status, body = request("GET", "manifest.json")
        if status == 200:
            try:
                remote_files = json.loads(body).get("files", [])
                remote_sha = {f["key"]: f.get("sha256") for f in remote_files}
                print(f"  manifest on R2: {len(remote_sha)} entries")
            except Exception:
                remote_files = []
    entries = []
    skipped = 0
    local_keys = set()
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
            status, _ = request("PUT", key, gz, {
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


def cmd_verify(dry: bool = False):
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


def cmd_enrich(dry: bool = False):
    """One-off: rebuild the manifest's `usable` flags by downloading each ETH
    object from R2 and mirroring lab.ts sessionUsable. Needed after the field
    was introduced for stores uploaded before it existed."""
    status, body = request("GET", "manifest.json")
    if status != 200:
        sys.exit(f"manifest fetch failed: HTTP {status}")
    m = json.loads(body)
    eth = [f for f in m["files"] if f["key"].startswith("data/") and f["key"].endswith("_ETH.json")]
    print(f"{len(eth)} ETH objects to check")
    for i, f in enumerate(eth, 1):
        st, b = request("GET", f["key"])
        if st != 200:
            print(f"  GET {f['key']} HTTP {st} — skipping")
            continue
        try:
            j = json.loads(gunzip_if_needed(b))
            f["usable"] = eth_usable(j.get("candles", []))
        except Exception:
            f["usable"] = None
        if i % 50 == 0:
            print(f"  {i}/{len(eth)} checked")
    if not dry:
        st, _ = request("PUT", "manifest.json", json.dumps(m).encode(), {"content-type": "application/json"})
        usable = sum(1 for f in eth if f.get("usable"))
        print(f"manifest rewritten HTTP {st} — {usable} usable ETH sessions of {len(eth)}")
    else:
        print("dry-run — manifest not written")


def cmd_rebuild(dry: bool = False):
    """Disaster recovery: rebuild the manifest from the bucket's object
    listing (used when the manifest was overwritten by a buggy incremental
    upload). ETH objects are downloaded to recompute candles + usable; other
    keys get minimal entries (their sha/counts refresh on the next upload)."""
    entries: list[dict] = []
    cursor = ""
    CF_TOKEN = env("CF_API_TOKEN")
    while True:
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects?per_page=100"
        if cursor:
            url += "&cursor=" + urllib.parse.quote(cursor)
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {CF_TOKEN}"}), timeout=60)
        page = json.loads(r.read())
        for obj in page.get("result", []):
            key = obj.get("key", "")
            if key.endswith(".json") and key.startswith("data/"):
                entries.append(minimal_entry(key))
        info = page.get("result_info", {})
        cursor = info.get("cursor") or ""
        if info.get("is_truncated") is False or not cursor:
            break
    print(f"{len(entries)} data objects listed")
    # ETH objects: download to recompute candles + usable
    eth = [e for e in entries if e["key"].endswith("_ETH.json")]
    for i, e in enumerate(eth, 1):
        st, b = request("GET", e["key"])
        if st == 200:
            try:
                j = json.loads(gunzip_if_needed(b))
                cs = j.get("candles", [])
                e["candles"] = len(cs)
                e["usable"] = eth_usable(cs)
                e["sha256"] = hashlib.sha256(gunzip_if_needed(b)).hexdigest()
                e["size_raw"] = len(gunzip_if_needed(b))
            except Exception:
                pass
        if i % 100 == 0:
            print(f"  {i}/{len(eth)} ETH checked")
    manifest = {"generated": datetime.now(timezone.utc).isoformat(), "bucket": BUCKET, "files": entries}
    if not dry:
        status, _ = request("PUT", "manifest.json", json.dumps(manifest).encode(), {"content-type": "application/json"})
        usable = sum(1 for e in eth if e.get("usable"))
        print(f"manifest rebuilt HTTP {status} — {len(entries)} entries, {usable} usable ETH sessions")
    else:
        print("dry-run — manifest not written")


def minimal_entry(key: str) -> dict:
    base = os.path.basename(key)
    date = base[:10] if base[:10].count("-") == 2 else base.split("_")[-1][:10]
    session = None
    if key.startswith("data/") and not key.startswith("data/ohlc") and not key.startswith("data/options"):
        session = "ETH" if "_ETH" in base else "RTH"
    return {"key": key, "date": date, "session": session, "candles": None, "usable": None,
            "size_raw": 0, "size_gz": 0, "sha256": ""}


def main() -> int:
    cmds = {"upload": cmd_upload, "verify": cmd_verify, "prune": cmd_prune, "enrich": cmd_enrich, "rebuild": cmd_rebuild}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        return 1
    dry = "--dry-run" in sys.argv
    cmds[sys.argv[1]](dry)
    return 0


if __name__ == "__main__":
    sys.exit(main())
