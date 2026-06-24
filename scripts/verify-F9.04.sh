#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f9-04-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/object-explorer/FilterChipBar.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '5 passed' "$LOG" && { echo "F9.04 GREEN"; exit 0; }
exit 1
