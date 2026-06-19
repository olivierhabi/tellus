#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/f6-aggregate.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"; docker ps --format '{{json .}}' >> "$LOG"
for sub in F6.01 F6.02 F6.03 F6.04 F6.05; do
  if [[ -x "$REPO_ROOT/scripts/verify-${sub}.sh" ]]; then
    bash "$REPO_ROOT/scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "F6 GREEN"
