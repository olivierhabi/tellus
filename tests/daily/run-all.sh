#!/usr/bin/env bash
# Run all daily test suites (unit + integration combined)
set -euo pipefail

DAYS=(monday tuesday wednesday thursday friday saturday sunday)
DIRS=()
for day in "${DAYS[@]}"; do
  DIRS+=("tests/${day}")
done

exec npx vitest run "${DIRS[@]}"
