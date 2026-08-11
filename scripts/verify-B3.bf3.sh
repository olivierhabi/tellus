#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/dc-up.sh" || true
bash "$REPO_ROOT/scripts/b3-c15-proof.sh"
status=$?
if [[ $status -ne 0 ]]; then
  echo "[verify-B3.bf3] proof harness exit=$status" >&2
  exit $status
fi

# Mirror of B1.bf2 Exit Gate (literal).
if test -s /tmp/b3-c15-green.log \
   && test -s /tmp/b3-c15-red.log \
   && test -s /tmp/b3-c15-green2.log \
   && grep -q 'PASS' /tmp/b3-c15-green.log \
   && grep -qE 'FAIL|✗|❌' /tmp/b3-c15-red.log \
   && grep -q 'PASS' /tmp/b3-c15-green2.log; then
  echo "B3.bf3 GREEN"
  exit 0
fi
echo "[verify-B3.bf3] gate failed" >&2
exit 1
