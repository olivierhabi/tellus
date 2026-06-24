#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-06-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-step1-orgs-integration.test.ts tests/foundry/integration/gatekeeper-b4-step2-markings-integration.test.ts 2>&1 | tee /tmp/b4-06-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Test Files +2 passed' /tmp/b4-06-test.log; then
  echo "B4.06 GREEN"
  exit 0
fi
echo "[verify-B4.06] gate failed status=$status" >&2
tail -25 /tmp/b4-06-test.log >&2
exit 1
