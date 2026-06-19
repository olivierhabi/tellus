#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b6-03-test.log
npx vitest run tests/foundry/integration/resource-graph-b6-03-integration.test.ts 2>&1 | tee /tmp/b6-03-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +5 passed|5 passed' /tmp/b6-03-test.log; then
  echo "B6.03 GREEN"; exit 0
fi
exit 1
