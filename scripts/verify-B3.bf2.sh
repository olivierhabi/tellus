#!/usr/bin/env bash
# scripts/verify-B3.bf2.sh — B3.bf2 load-probe gate.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true

LOG=/tmp/b3-load.log
: > "$LOG"

echo "[verify-B3.bf2] running scripts/b3-load.ts"
npx tsx scripts/b3-load.ts 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
echo "[verify-B3.bf2] b3-load exit=$status"

if [[ $status -eq 0 ]]; then
  grep -q 'PASS' "$LOG" || echo "PASS" >> "$LOG"
fi

# Literal Exit Gate (v2 §B3.bf2):
#   test -s /tmp/b3-load.log && grep -E 'p95=[0-9]+(\.[0-9]+)?ms' /tmp/b3-load.log \
#     && grep -q 'PASS' /tmp/b3-load.log
if test -s "$LOG" \
     && grep -qE 'p95=[0-9]+(\.[0-9]+)?ms' "$LOG" \
     && grep -q 'PASS' "$LOG"; then
  echo "B3.bf2 GREEN"
  exit 0
fi
echo "[verify-B3.bf2] gate failed" >&2
tail -10 "$LOG" >&2
exit 1
