#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b9-09-test.log
npx vitest run tests/foundry/integration/funnel-b9-09-replacement-integration.test.ts 2>&1 | tee /tmp/b9-09-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +2 passed|2 passed' /tmp/b9-09-test.log; then
  echo "B9.09 GREEN"; exit 0
fi
exit 1
