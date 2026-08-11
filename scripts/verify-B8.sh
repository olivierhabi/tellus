#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
LOG=/tmp/b8-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in B8.01 B8.02 B8.03 B8.04 B8.05 B8.06 B8.07 B8.08 B8.09 B8.10 B8.11 B8.12 B8.13 B8.14 B8.15; do
  if [[ -x "scripts/verify-${sub}.sh" ]]; then
    bash "scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "B8 GREEN"
