#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b9-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in B9.01 B9.02 B9.03 B9.04 B9.05 B9.06 B9.07 B9.08 B9.09 B9.10 B9.11 B9.12; do
  if [[ -x "scripts/verify-${sub}.sh" ]]; then
    bash "scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "B9 GREEN"
