#!/usr/bin/env bash
set -uo pipefail
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f8-08-test.log; : > "$LOG"
(cd "$FE" && npx vitest run tests/unit/ontology/SaveBanner.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
[[ $status -eq 0 ]] && grep -qE '10 passed' "$LOG" && { echo "F8.08 GREEN"; exit 0; }
exit 1
