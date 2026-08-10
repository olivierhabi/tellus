#!/usr/bin/env bash
# Run all Data Connection API tests in sequence.
# Usage: ./run-api-tests.sh
#
# Each test is a standalone node script that logs in via real Keycloak
# and makes assertions against the running backend on :3000.
# A test "passing" exits 0; "failing" exits non-zero.
# This runner stops on the first failure.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../../.."  # backend root (up from scripts/qa/api-tests)

# Load .env so the DB connection + Keycloak URLs are available.
set -a
source .env
set +a

echo "=========================================="
echo "Data Connection API Test Suite"
echo "=========================================="
echo ""

PASS=0
FAIL=0
TESTS=(
  "00-smoke.ts"
  "01-f2-reaper.ts"
  "02-f4-cdc-enum.ts"
  "03-f5-openapi-gap.ts"
  "04-f3-vault-empty.ts"
  "05-f7-agent-egress.ts"
  "06-f8-named-secrets.ts"
  "07-f9-duplicate-webhooks.ts"
)

for t in "${TESTS[@]}"; do
  echo "--- $t ---"
  if npx tsx "scripts/qa/api-tests/$t" 2>&1 | tail -15; then
    echo "✓ $t PASSED"
    PASS=$((PASS + 1))
  else
    echo "✗ $t FAILED"
    FAIL=$((FAIL + 1))
    break  # stop on first failure
  fi
  echo ""
done

echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================================="
exit $FAIL
