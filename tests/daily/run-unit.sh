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
# Pipeline Builder / Funnel Hardening / Link Types work (PB-B1..B10 +
# FNL-H + LT-B). Lives under tests/foundry/ so the weekday buckets
# above stay stable; keeping it here makes `npm run test:unit` cover
# the uncommitted PB-B guards (p95 compile, trace overhead, schema
# transition timing, etc.) and every other pb-b*-unit.test.ts file.
DIRS+=("tests/foundry/unit")

exec npx vitest run "${DIRS[@]}"
