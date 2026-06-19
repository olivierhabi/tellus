#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b4-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"
docker ps --format '{{json .}}' >> "$LOG"
echo "=== begin B4 aggregate ===" >> "$LOG"

for sub in B4.01 B4.02 B4.03 B4.04 B4.05 B4.06 B4.07 B4.08 B4.09 B4.10 B4.11; do
  if [[ -x "scripts/verify-${sub}.sh" ]]; then
    echo "[B4-aggregate] running ${sub}" | tee -a "$LOG"
    bash "scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    if [[ $s -ne 0 ]]; then
      echo "[B4-aggregate] ${sub} failed status=$s" | tee -a "$LOG" >&2
      exit 1
    fi
  fi
done

echo "[B4-aggregate] running b4-load.ts" | tee -a "$LOG"
LLOG=/tmp/b4-load.log; : > "$LLOG"
npx tsx scripts/b4-load.ts 2>&1 | tee -a "$LLOG" "$LOG"

echo "PASS — all B4 sub-gates green" | tee -a "$LOG"
echo "B4 GREEN"
exit 0
