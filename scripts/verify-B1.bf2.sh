#!/usr/bin/env bash
# scripts/verify-B1.bf2.sh — Turn-level verify for B1.bf2 (B1-C-24 triplet).
# Exits 0 only when the literal v2 §B1.bf2 Exit Gate exits 0.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash "$REPO_ROOT/scripts/dc-up.sh" || true

bash "$REPO_ROOT/scripts/b1-c24-proof.sh"
phase=$?
if [[ $phase -ne 0 ]]; then
  echo "[verify-B1.bf2] triplet harness failed with exit $phase" >&2
  exit "$phase"
fi

if test -s /tmp/b1-c24-green.log && \
   test -s /tmp/b1-c24-red.log && \
   test -s /tmp/b1-c24-green2.log && \
   grep -q 'PASS' /tmp/b1-c24-green.log && \
   grep -qE 'FAIL|✗|❌' /tmp/b1-c24-red.log && \
   grep -q 'PASS' /tmp/b1-c24-green2.log; then
  echo "B1.bf2 GREEN"
  exit 0
fi
echo "[verify-B1.bf2] gate failed" >&2
exit 1
