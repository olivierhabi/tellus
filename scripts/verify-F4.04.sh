#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f4-04-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/share-dialog/MarkingsTab.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '6 passed' "$LOG" && { echo "F4.04 GREEN"; exit 0; }
exit 1
