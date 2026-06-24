#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f6-02-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/trash/RestoreDialog.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '5 passed' "$LOG" && { echo "F6.02 GREEN"; exit 0; }
exit 1
