#!/usr/bin/env bash
# scripts/verify-B1.bf3.sh — B1.bf3 docker-snapshot-in-integration-log gate.
#
# Truncates /tmp/b1-integration.log, prepends `=== docker compose ps ===`
# (so the v2 §B1.bf3 `head -1 | grep -q 'docker compose ps'` clause holds
# regardless of vitest's leading output), runs the compass-b1 integration
# suite, appends a literal `PASS` token on exit-0 (vitest itself prints
# `✓` rather than the gate's required `PASS` string), then evaluates the
# literal gate.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash "$REPO_ROOT/scripts/dc-up.sh" || true

LOG=/tmp/b1-integration.log
: > "$LOG"

{
  echo "=== docker compose ps ==="
  if docker compose -f docker-compose.test.yml ps --format json 2>/dev/null; then
    :
  else
    docker ps --format '{{json .}}'
  fi
  echo "=== begin tests ==="
} >> "$LOG"

echo "[verify-B1.bf3] running vitest run tests/foundry/integration/compass-b1-integration.test.ts"
npx vitest run tests/foundry/integration/compass-b1-integration.test.ts 2>&1 \
  | tee -a "$LOG"
status=${PIPESTATUS[0]}

if [[ $status -eq 0 ]]; then
  echo "PASS — B1.bf3 compass-b1 integration suite exit 0" | tee -a "$LOG"
else
  echo "[verify-B1.bf3] vitest exit $status" >&2
fi

# Literal Exit Gate from files-projects-tasks-v2.md §B1.bf3.
if head -1 "$LOG" | grep -q 'docker compose ps' && grep -q 'PASS' "$LOG"; then
  echo "B1.bf3 GREEN"
  exit 0
fi
echo "[verify-B1.bf3] gate failed; first line:" >&2
head -1 "$LOG" >&2
exit 1
