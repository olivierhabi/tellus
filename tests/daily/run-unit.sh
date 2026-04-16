#!/usr/bin/env bash
# Run all daily unit test suites
set -euo pipefail

DAYS=(monday tuesday wednesday thursday friday saturday sunday)
DIRS=()
for day in "${DAYS[@]}"; do
  DIRS+=("tests/${day}/unit")
done

exec npx vitest run "${DIRS[@]}"
