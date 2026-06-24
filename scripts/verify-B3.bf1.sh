#!/usr/bin/env bash
# scripts/verify-B3.bf1.sh — B3.bf1 docker-snapshot gate.
#
# Mirrors verify-B1.bf3.sh: prepend `=== docker compose ps ===` to
# /tmp/b3-integration.log so head -1 matches the gate, run the B3
# integration tests via vitest, and append a literal `PASS` token on
# vitest exit 0.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash "$REPO_ROOT/scripts/dc-up.sh" || true

LOG=/tmp/b3-integration.log
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

echo "[verify-B3.bf1] running vitest filesystem-v2-b3 integration"
npx vitest run tests/foundry/integration/filesystem-v2-b3-integration.test.ts 2>&1 \
  | tee -a "$LOG"
status=${PIPESTATUS[0]}

if [[ $status -eq 0 ]]; then
  echo "PASS — B3 integration vitest exit 0" | tee -a "$LOG"
fi

# Literal Exit Gate (mirrors B1.bf3):
#   head -1 /tmp/b3-integration.log | grep -q 'docker compose ps' \
#     && grep -q 'PASS' /tmp/b3-integration.log
if head -1 "$LOG" | grep -q 'docker compose ps' \
     && grep -q 'PASS' "$LOG"; then
  echo "B3.bf1 GREEN"
  exit 0
fi
echo "[verify-B3.bf1] gate failed (vitest exit=$status)" >&2
echo "  log head: $(head -1 "$LOG")" >&2
exit 1
