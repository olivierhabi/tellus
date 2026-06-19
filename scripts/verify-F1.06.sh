#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f1-06-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/files-projects/HeaderSearch.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '3 passed' "$LOG" && { echo "F1.06 GREEN"; exit 0; }
exit 1
