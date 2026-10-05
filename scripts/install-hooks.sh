#!/usr/bin/env bash
# Install the repo's pre-push execution gate into .git/hooks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/scripts/git-hooks/pre-push" "$ROOT/.git/hooks/pre-push"
chmod +x "$ROOT/.git/hooks/pre-push"
echo "installed $ROOT/.git/hooks/pre-push (live-execution push gate)"
