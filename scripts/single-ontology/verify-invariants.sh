#!/usr/bin/env bash
# ===========================================================================
# verify-invariants.sh — assert the "One Enterprise, One Ontology" invariants
# ===========================================================================
# Usage:
#   verify-invariants.sh [DB_NAME] [--expect-instances N]
#
# Runs a battery of SQL assertions against DB_NAME (default: tellus_db) inside
# the Postgres container. Prints PASS/FAIL per check and exits non-zero if any
# invariant is violated. Safe + read-only except for one rolled-back probe that
# proves the singleton guard rejects a second ontology.
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
DB="${1:-tellus_db}"
PGUSER="${TELLUS_PG_USER:-tellus}"
CANON="00000000-0000-0000-0000-000000000001"
EXPECT_INSTANCES=""

# parse optional --expect-instances
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-instances) EXPECT_INSTANCES="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

q() { docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc "$1"; }

pass=0; fail=0
check() { # check "label" "actual" "expected"
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-52s (%s)\n' "$label" "$actual"
    pass=$((pass+1))
  else
    printf '  \033[31mFAIL\033[0m  %-52s got=%s want=%s\n' "$label" "$actual" "$expected"
    fail=$((fail+1))
  fi
}

echo "── Verifying single-ontology invariants on DB '$DB' ──"

check "exactly one ontology row" \
  "$(q "SELECT count(*) FROM ontology;")" "1"

check "canonical ontology exists" \
  "$(q "SELECT count(*) FROM ontology WHERE ontology_id='$CANON';")" "1"

check "canonical display name" \
  "$(q "SELECT display_name FROM ontology WHERE ontology_id='$CANON';")" "Enterprise Ontology"

check "singleton guard index present" \
  "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_ontology_singleton';")" "1"

# No ontology-scoped row points anywhere but canonical.
for t in object_type link_type action_type interface object_type_group \
         ontology_function saved_exploration export_job ontology_edit link_edit \
         ontology_branch object_instances funnel_run funnel_signal \
         funnel_changelog_watermark; do
  check "no off-canon rows in $t" \
    "$(q "SELECT count(*) FROM $t WHERE ontology_id <> '$CANON';")" "0"
done

check "exactly one 'main' branch for canonical" \
  "$(q "SELECT count(*) FROM ontology_branch WHERE ontology_id='$CANON' AND name='main';")" "1"

check "object_type api_names unique within ontology" \
  "$(q "SELECT count(*) FROM (SELECT api_name FROM object_type WHERE ontology_id='$CANON' GROUP BY api_name HAVING count(*)>1) d;")" "0"

# Singleton guard actually rejects a second ontology (rolled back).
GUARD_BLOCKS=$(docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc \
  "BEGIN; INSERT INTO ontology (display_name) VALUES ('__guard_probe__'); ROLLBACK;" 2>&1 \
  | grep -c "uq_ontology_singleton\|unique" || true)
check "guard rejects a 2nd ontology insert" \
  "$([[ "$GUARD_BLOCKS" -ge 1 ]] && echo yes || echo no)" "yes"

if [[ -n "$EXPECT_INSTANCES" ]]; then
  check "object_instances preserved (no data loss)" \
    "$(q "SELECT count(*) FROM object_instances;")" "$EXPECT_INSTANCES"
fi

echo "── $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]
