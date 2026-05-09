#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f6-05-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/trash/EmptyTrashButton.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '4 passed' "$LOG" && { echo "F6.05 GREEN"; exit 0; }
exit 1
