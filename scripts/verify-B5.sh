#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b5-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"
docker ps --format '{{json .}}' >> "$LOG"
for sub in B5.01 B5.02 B5.03 B5.04 B5.05 B5.06 B5.07 B5.08; do
  if [[ -x "scripts/verify-${sub}.sh" ]]; then
    echo "[B5-aggregate] ${sub}" | tee -a "$LOG"
    bash "scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    if [[ $s -ne 0 ]]; then echo "[B5-aggregate] ${sub} failed" >&2; exit 1; fi
  fi
done
echo "B5 GREEN"
