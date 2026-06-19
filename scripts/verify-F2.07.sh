#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f2-07-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/projects-detail/SettingsTab.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '8 passed' "$LOG" && { echo "F2.07 GREEN"; exit 0; }
exit 1
