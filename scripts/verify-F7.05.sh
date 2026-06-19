#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f7-05-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/branches/BranchesListView.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '6 passed' "$LOG" && { echo "F7.05 GREEN"; exit 0; }
exit 1
