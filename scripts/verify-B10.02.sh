#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b10-02-test.log
npx vitest run tests/foundry/integration/oss-b10-02-ir-compile-integration.test.ts 2>&1 | tee /tmp/b10-02-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +14 passed|14 passed' /tmp/b10-02-test.log; then
  echo "B10.02 GREEN"; exit 0
fi
exit 1
