#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b7-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in B7.01 B7.02 B7.03 B7.04 B7.05 B7.06 B7.07 B7.08 B7.09 B7.10 B7.11 B7.12; do
  if [[ -x "scripts/verify-${sub}.sh" ]]; then
    bash "scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "B7 GREEN"
