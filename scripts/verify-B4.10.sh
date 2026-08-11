#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
npm run migrate:foundry 2>&1 | tail -5
: > /tmp/b4-10-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-cache-integration.test.ts 2>&1 | tee /tmp/b4-10-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +3 passed|3 passed' /tmp/b4-10-test.log; then
  echo "B4.10 GREEN"; exit 0
fi
exit 1
