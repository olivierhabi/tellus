#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-08-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-full-flow-integration.test.ts 2>&1 | tee /tmp/b4-08-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +4 passed|4 passed' /tmp/b4-08-test.log; then
  echo "B4.08 GREEN"; exit 0
fi
echo "[verify-B4.08] gate failed status=$status" >&2
tail -20 /tmp/b4-08-test.log >&2
exit 1
