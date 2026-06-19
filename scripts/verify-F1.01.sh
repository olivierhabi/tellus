#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=/Users/olivierhabimana/Desktop/projects/tellus-fe
LOG=/tmp/f1-01-test.log
: > "$LOG"
(cd "$FE" && npx vitest run tests/unit/files-projects/FilesPageHeader-FilesTabBar.test.tsx 2>&1) | tee "$LOG"
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +6 passed|6 passed' "$LOG"; then
  echo "F1.01 GREEN"; exit 0
fi
echo "[verify-F1.01] gate failed status=$status" >&2
exit 1
