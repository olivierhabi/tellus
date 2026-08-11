#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/f5-04-test.log
npx vitest run tests/foundry/integration/filesystem-search-f5-04-integration.test.ts 2>&1 | tee /tmp/f5-04-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' /tmp/f5-04-test.log; then
  echo "F5.04 GREEN"; exit 0
fi
exit 1
