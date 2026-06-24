#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/f2-aggregate.log; : > "$LOG"
for sub in F2.01 F2.02 F2.03 F2.04 F2.05 F2.06 F2.07; do
  if [[ -x "$REPO_ROOT/scripts/verify-${sub}.sh" ]]; then
    bash "$REPO_ROOT/scripts/verify-${sub}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && exit 1
  fi
done
echo "F2 GREEN"
