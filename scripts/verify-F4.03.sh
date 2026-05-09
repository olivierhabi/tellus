#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f4-03-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/share-dialog/RolesTab.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '6 passed' "$LOG" && { echo "F4.03 GREEN"; exit 0; }
exit 1
