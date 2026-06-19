#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-03-test.log
npm run migrate:foundry 2>&1 | tee /tmp/b4-03-migrate.log
npx vitest run tests/foundry/integration/gatekeeper-b4-markings-tables-integration.test.ts 2>&1 | tee /tmp/b4-03-test.log
status=${PIPESTATUS[0]}
if [[ $status -eq 0 ]] && grep -qE 'Tests +3 passed|3 passed' /tmp/b4-03-test.log; then
  echo "B4.03 GREEN"
  exit 0
fi
echo "[verify-B4.03] gate failed status=$status" >&2
tail -20 /tmp/b4-03-test.log >&2
exit 1
