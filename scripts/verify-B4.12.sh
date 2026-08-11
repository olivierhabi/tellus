#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
LOG=/tmp/b4-12-load.log
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > "$LOG"
npx tsx scripts/b4-load.ts 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -q 'PASS' "$LOG" && grep -qE 'p95=[0-9.]+ms' "$LOG"; then
  echo "B4.12 GREEN"
  exit 0
fi
exit 1
