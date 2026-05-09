#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b8-08-test.log
npx vitest run tests/foundry/integration/oms-b8-08-get-list-integration.test.ts 2>&1 | tee /tmp/b8-08-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +5 passed|5 passed' /tmp/b8-08-test.log; then
  echo "B8.08 GREEN"; exit 0
fi
exit 1
