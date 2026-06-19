#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b6-02-test.log
npx vitest run tests/foundry/integration/resource-graph-b6-02-integration.test.ts 2>&1 | tee /tmp/b6-02-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +3 passed|3 passed' /tmp/b6-02-test.log; then
  echo "B6.02 GREEN"; exit 0
fi
exit 1
