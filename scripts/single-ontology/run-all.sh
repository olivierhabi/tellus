#!/usr/bin/env bash
# ===========================================================================
# run-all.sh — full verification suite for "One Enterprise, One Ontology"
# ===========================================================================
# 1. Invariants on the live database (must already be consolidated)
# 2. Migration replay on a throwaway clone (idempotency + no data loss)
# 3. Multi→single merge fixture (collision rename + branch fold, end-to-end)
# 4. Authenticated API smoke test (skips if no token available)
# ===========================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${TELLUS_PG_DB:-tellus_db}"

echo "════════════════════════════════════════════════════════════════"
echo " 1/4  Live-DB invariants ($DB)"
echo "════════════════════════════════════════════════════════════════"
bash "$HERE/verify-invariants.sh" "$DB"

echo; echo "════════════════════════════════════════════════════════════════"
echo " 2/4  Migration replay on a clone"
echo "════════════════════════════════════════════════════════════════"
bash "$HERE/test-on-clone.sh"

echo; echo "════════════════════════════════════════════════════════════════"
echo " 3/4  Multi→single merge fixture"
echo "════════════════════════════════════════════════════════════════"
bash "$HERE/test-merge-fixture.sh"

echo; echo "════════════════════════════════════════════════════════════════"
echo " 4/4  Authenticated API smoke test"
echo "════════════════════════════════════════════════════════════════"
bash "$HERE/smoke-api.sh"

echo; echo "✅ All single-ontology verification stages completed."
