#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b10-06-test.log
npx vitest run tests/foundry/integration/oss-b10-06-search-around-integration.test.ts 2>&1 | tee /tmp/b10-06-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' /tmp/b10-06-test.log; then
  echo "B10.06 GREEN"; exit 0
fi
exit 1
