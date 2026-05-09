#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true

: > /tmp/b4-01-migrate.log
npm run migrate:foundry 2>&1 | tee /tmp/b4-01-migrate.log
mst=${PIPESTATUS[0]}

: > /tmp/b4-01-test.log
npx vitest run tests/foundry/integration/gatekeeper-b4-roles-table-integration.test.ts 2>&1 | tee -a /tmp/b4-01-test.log
tst=${PIPESTATUS[0]}

# Literal Exit Gate (v2 §B4.01):
#   pnpm migrate ... && pnpm test ... && grep -q '3 passed'
if [[ $mst -eq 0 ]] && [[ $tst -eq 0 ]] && grep -qE '3 passed|Tests +3 passed' /tmp/b4-01-test.log; then
  echo "B4.01 GREEN"
  exit 0
fi
echo "[verify-B4.01] gate failed (migrate=$mst test=$tst)" >&2
tail -20 /tmp/b4-01-test.log >&2
exit 1
