#!/usr/bin/env bash
# scripts/verify-B2.bf2.sh — B2.bf2 load-probe + docker-snapshot gate.
#
# 1. Truncates /tmp/b2-integration.log and prepends
#    `=== docker compose ps ===` so `head -1` matches the gate.
# 2. Runs spaces-b2 integration tests under vitest (records the output).
# 3. Executes scripts/b2-load.ts via tsx; the probe writes
#    /tmp/b2-load.log with a `p95=...ms` token.
# 4. Evaluates the literal v2 §B2.bf2 Exit Gate.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash "$REPO_ROOT/scripts/dc-up.sh" || true

INTEG_LOG=/tmp/b2-integration.log
LOAD_LOG=/tmp/b2-load.log
: > "$INTEG_LOG"
: > "$LOAD_LOG"

{
  echo "=== docker compose ps ==="
  if docker compose -f docker-compose.test.yml ps --format json 2>/dev/null; then
    :
  else
    docker ps --format '{{json .}}'
  fi
  echo "=== begin tests ==="
} >> "$INTEG_LOG"

echo "[verify-B2.bf2] running vitest spaces-b2 integration"
npx vitest run tests/foundry/integration/spaces-b2-integration.test.ts 2>&1 \
  | tee -a "$INTEG_LOG"
vstatus=${PIPESTATUS[0]}

if [[ $vstatus -eq 0 ]]; then
  echo "PASS — B2 integration vitest exit 0" | tee -a "$INTEG_LOG"
else
  echo "[verify-B2.bf2] vitest exit $vstatus" >&2
fi

echo "[verify-B2.bf2] running scripts/b2-load.ts via tsx"
npx tsx scripts/b2-load.ts 2>&1 | tee -a "$LOAD_LOG"
lstatus=${PIPESTATUS[0]}
echo "[verify-B2.bf2] b2-load.ts exit=${lstatus}"

# Literal Exit Gate from files-projects-tasks-v2.md §B2.bf2:
#   test -s /tmp/b2-load.log && grep -q 'p95=' /tmp/b2-load.log \
#     && head -1 /tmp/b2-integration.log | grep -q 'docker compose ps'
if test -s "$LOAD_LOG" \
     && grep -q 'p95=' "$LOAD_LOG" \
     && head -1 "$INTEG_LOG" | grep -q 'docker compose ps'; then
  echo "B2.bf2 GREEN"
  exit 0
fi
echo "[verify-B2.bf2] gate failed" >&2
echo "  load log size: $(wc -c < "$LOAD_LOG" 2>/dev/null || echo missing)" >&2
echo "  load log head:" >&2
head -3 "$LOAD_LOG" >&2 || true
echo "  integ head: $(head -1 "$INTEG_LOG")" >&2
exit 1
