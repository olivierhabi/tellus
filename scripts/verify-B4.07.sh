#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-07-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-step3-roles-integration.test.ts 2>&1 | tee /tmp/b4-07-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +10 passed|10 passed' /tmp/b4-07-test.log; then
  echo "B4.07 GREEN"
  exit 0
fi
echo "[verify-B4.07] gate failed status=$status" >&2
tail -25 /tmp/b4-07-test.log >&2
exit 1
