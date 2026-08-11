#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-11-test.log
npx vitest run tests/foundry/integration/requirePermission-b4-11-integration.test.ts 2>&1 | tee /tmp/b4-11-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +5 passed|5 passed' /tmp/b4-11-test.log; then
  echo "B4.11 GREEN"; exit 0
fi
exit 1
