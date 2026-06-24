#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
npm run migrate:foundry 2>&1 | tail -3
: > /tmp/b6-01-test.log
npx vitest run tests/foundry/integration/resource-graph-b6-01-integration.test.ts 2>&1 | tee /tmp/b6-01-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +3 passed|3 passed' /tmp/b6-01-test.log; then
  echo "B6.01 GREEN"; exit 0
fi
exit 1
