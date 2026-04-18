#!/usr/bin/env bash
# Run all daily unit test suites
set -euo pipefail

DAYS=(monday tuesday wednesday thursday friday saturday sunday)
DIRS=()
for day in "${DAYS[@]}"; do
  DIRS+=("tests/${day}/unit")
done
# Non-day-keyed unit suites. The Funnel work (stageDelay env parsing,
# objectDataStore deriveSchemaStatus) spans tasks B1–B10 and doesn't
# belong to a single weekday bucket, so it lives under tests/funnel/.
DIRS+=("tests/funnel/unit")

exec npx vitest run "${DIRS[@]}"
