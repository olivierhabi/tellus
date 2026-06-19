#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/f10-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in F10.01 F10.02 F10.03 F10.04 F10.05 F10.06 F10.07 F10.08 F10.09; do
  if [[ -x "$REPO_ROOT/scripts/verify-${sub}.sh" ]]; then
    bash "$REPO_ROOT/scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "F10 GREEN"
