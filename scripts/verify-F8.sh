#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/f8-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in F8.01 F8.02 F8.03 F8.04 F8.05 F8.06 F8.07 F8.08 F8.09; do
  if [[ -x "$REPO_ROOT/scripts/verify-${sub}.sh" ]]; then
    bash "$REPO_ROOT/scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "F8 GREEN"
