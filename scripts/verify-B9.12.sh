#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b9-12-load.log; : > "$LOG"
npx tsx scripts/b9-load.ts 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -q 'PASS' "$LOG" && grep -qE 'ops/sec=[0-9]+' "$LOG"; then
  echo "B9.12 GREEN"; exit 0
fi
exit 1
