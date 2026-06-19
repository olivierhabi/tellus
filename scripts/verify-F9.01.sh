#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f9-01-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/object-explorer/ObjectExplorerScaffold.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '2 passed' "$LOG" && { echo "F9.01 GREEN"; exit 0; }
exit 1
