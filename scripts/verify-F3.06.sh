#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f3-06-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/file-explorer/useKeyboardShortcuts.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '9 passed' "$LOG" && { echo "F3.06 GREEN"; exit 0; }
exit 1
