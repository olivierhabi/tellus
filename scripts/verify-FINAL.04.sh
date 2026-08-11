#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/final-04-test.log
npx vitest run tests/foundry/integration/final-04-branch-merge-integration.test.ts 2>&1 | tee /tmp/final-04-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' /tmp/final-04-test.log; then
  echo "FINAL.04 GREEN"; exit 0
fi
exit 1
