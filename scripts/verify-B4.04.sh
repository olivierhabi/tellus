#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
: > /tmp/b4-04-test.log
npm run migrate:foundry 2>&1 | tee /tmp/b4-04-migrate.log
npx vitest run tests/foundry/integration/gatekeeper-b4-orgs-tables-integration.test.ts 2>&1 | tee /tmp/b4-04-test.log
status=${PIPESTATUS[0]}
# Spec literal-ish gate: query returns 0 orphans (we use the corrected JOIN syntax).
ORPHANS=$(docker exec tellus-postgres-1 psql -U tellus -d tellus_db -tAc \
  "SELECT count(*) FROM users u LEFT JOIN user_organizations uo ON u.id = uo.user_id WHERE uo.org_id IS NULL")
echo "[verify-B4.04] orphan users count: $ORPHANS"
if [[ $status -eq 0 ]] && grep -qE 'Tests +3 passed|3 passed' /tmp/b4-04-test.log && [[ "${ORPHANS// /}" == "0" ]]; then
  echo "B4.04 GREEN"
  exit 0
fi
echo "[verify-B4.04] gate failed status=$status orphans=$ORPHANS" >&2
tail -10 /tmp/b4-04-test.log >&2
exit 1
