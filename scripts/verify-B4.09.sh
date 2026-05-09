#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-09-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-batch-integration.test.ts 2>&1 | tee /tmp/b4-09-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' /tmp/b4-09-test.log; then
  echo "B4.09 GREEN"; exit 0
fi
exit 1
