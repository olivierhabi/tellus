#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b10-01-test.log
npx vitest run tests/foundry/integration/oss-b10-01-ir-schema-integration.test.ts 2>&1 | tee /tmp/b10-01-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +10 passed|10 passed' /tmp/b10-01-test.log; then
  echo "B10.01 GREEN"; exit 0
fi
exit 1
