#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f1-02-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/files-projects/ProjectsTable.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' "$LOG"; then
  echo "F1.02 GREEN"; exit 0
fi
exit 1
