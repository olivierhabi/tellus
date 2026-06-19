#!/usr/bin/env bash
# ===========================================================================
# test-merge-fixture.sh — prove the multi→single merge end-to-end
# ===========================================================================
# The real DB is already consolidated, so it can no longer demonstrate the
# 7→1 transition. This test reconstructs a multi-ontology state on a throwaway
# clone: it injects a SECOND ontology (own main branch, a colliding object type
# named "Taxpayer", a fixture-only type, and instances), then runs the
# consolidation migration and asserts that everything folds into the single
# enterprise ontology with the collision renamed and zero data loss.
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${TELLUS_PG_USER:-tellus}"
SRC_DB="${TELLUS_PG_DB:-tellus_db}"
SCRATCH="tellus_so_fixture"
CANON="00000000-0000-0000-0000-000000000001"
FIXT="00000000-0000-0000-0000-0000000000f2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC="$HERE/../../src/migrations/099_consolidate_procedure.sql"
MIGRATION="$HERE/../../src/migrations/100_single_enterprise_ontology.sql"

q()  { docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$1" -tAc "$2"; }
adm(){ docker exec -i "$CONTAINER" psql -U "$PGUSER" -d postgres -c "$1"; }

echo "── Cloning '$SRC_DB' → '$SCRATCH' ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
adm "CREATE DATABASE $SCRATCH;" >/dev/null
docker exec -i "$CONTAINER" sh -c \
  "pg_dump -U $PGUSER -d $SRC_DB --no-owner --no-privileges | psql -U $PGUSER -d $SCRATCH -q" \
  >/dev/null

echo "── Injecting a second ontology + colliding type + instances ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 >/dev/null <<SQL
DROP INDEX IF EXISTS uq_ontology_singleton;   -- temporarily lift the guard to inject
DO \$f\$
DECLARE bb uuid;
BEGIN
  INSERT INTO ontology (ontology_id, display_name, description, created_by)
    VALUES ('$FIXT', 'Fixture Ontology B', 'merge-test fixture', 'fixture');
  bb := uuid_generate_v5(uuid_ns_dns(), '$FIXT:main');
  INSERT INTO ontology_branch (branch_id, ontology_id, name, status, created_by)
    VALUES (bb, '$FIXT', 'main', 'OPEN', 'fixture');
  INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, created_by)
    VALUES (gen_random_uuid(), '$FIXT', 'Taxpayer', 'Taxpayer (B)', 'fixture'),
           (gen_random_uuid(), '$FIXT', 'FixtureOnlyType', 'Fixture Only', 'fixture');
  INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties)
    VALUES ('$FIXT', bb, 'Taxpayer', 'B-TP-1', '{}'),
           ('$FIXT', bb, 'Taxpayer', 'B-TP-2', '{}'),
           ('$FIXT', bb, 'FixtureOnlyType', 'B-FX-1', '{}');
END
\$f\$;
SQL

PRE_ONT=$(q "$SCRATCH" "SELECT count(*) FROM ontology;")
PRE_INST=$(q "$SCRATCH" "SELECT count(*) FROM object_instances;")
echo "  injected → ontologies=$PRE_ONT instances=$PRE_INST"
[[ "$PRE_ONT" == "2" ]] || { echo "fixture setup failed (expected 2 ontologies)"; exit 1; }

echo "── Running consolidation migration (099 procedure + 100 gate) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 < "$PROC" >/dev/null
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 \
  --single-transaction < "$MIGRATION" >/dev/null

echo "── Asserting merge outcome ──"
pass=0; fail=0
chk(){ if [[ "$2" == "$3" ]]; then printf '  \033[32mPASS\033[0m  %-46s (%s)\n' "$1" "$2"; pass=$((pass+1));
       else printf '  \033[31mFAIL\033[0m  %-46s got=%s want=%s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

chk "two ontologies folded into one"        "$(q "$SCRATCH" "SELECT count(*) FROM ontology;")" "1"
chk "no data loss (instances preserved)"    "$(q "$SCRATCH" "SELECT count(*) FROM object_instances;")" "$PRE_INST"
chk "fixture-B ontology gone"               "$(q "$SCRATCH" "SELECT count(*) FROM ontology WHERE ontology_id='$FIXT';")" "0"
chk "exactly one 'Taxpayer' kept the name"  "$(q "$SCRATCH" "SELECT count(*) FROM object_type WHERE ontology_id='$CANON' AND api_name='Taxpayer';")" "1"
chk "colliding Taxpayer was renamed (2 total)" "$(q "$SCRATCH" "SELECT count(*) FROM object_type WHERE ontology_id='$CANON' AND api_name LIKE 'Taxpayer%';")" "2"
chk "fixture-only type migrated"            "$(q "$SCRATCH" "SELECT count(*) FROM object_type WHERE ontology_id='$CANON' AND api_name='FixtureOnlyType';")" "1"
chk "renamed type's instances preserved"    "$(q "$SCRATCH" "SELECT count(*) FROM object_instances WHERE object_type_api_name LIKE 'Taxpayer__%';")" "2"
chk "all instances on canonical ontology"   "$(q "$SCRATCH" "SELECT count(*) FROM object_instances WHERE ontology_id<>'$CANON';")" "0"
chk "guard index re-created"                "$(q "$SCRATCH" "SELECT count(*) FROM pg_indexes WHERE indexname='uq_ontology_singleton';")" "1"

echo "── $pass passed, $fail failed ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
[[ "$fail" -eq 0 ]] && echo "✅ Merge fixture test passed: 2 ontologies → 1, collision renamed, no data loss."
[[ "$fail" -eq 0 ]]
