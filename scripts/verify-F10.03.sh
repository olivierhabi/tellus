#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f10-03-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/canvas/ObjectSetSourceCard.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '4 passed' "$LOG" && { echo "F10.03 GREEN"; exit 0; }
exit 1
