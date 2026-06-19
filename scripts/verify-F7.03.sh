#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f7-03-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/branches/branchAwareUrl.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '7 passed' "$LOG" && { echo "F7.03 GREEN"; exit 0; }
exit 1
