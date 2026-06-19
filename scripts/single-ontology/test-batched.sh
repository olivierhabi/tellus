#!/usr/bin/env bash
# ===========================================================================
# test-batched.sh — prove batched consolidation + the migration gate
# ===========================================================================
# On a throwaway clone, injects a second ontology with a large instance set and
# a colliding object type, then:
#   1. GATE: migration 100 with a low inline threshold must REFUSE (raise),
#      leaving the data untouched.
#   2. BATCHED: consolidate_single_ontology(BATCH) folds everything in chunks
#      with COMMIT per chunk — single ontology, collision renamed, no data loss.
# ===========================================================================
set -euo pipefail

CONTAINER="${TELLUS_PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${TELLUS_PG_USER:-tellus}"
SRC_DB="${TELLUS_PG_DB:-tellus_db}"
SCRATCH="tellus_so_batched"
CANON="00000000-0000-0000-0000-000000000001"
ROWS="${ROWS:-5000}"
BATCH="${BATCH:-500}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC="$HERE/../../src/migrations/099_consolidate_procedure.sql"
MIGRATION="$HERE/../../src/migrations/100_single_enterprise_ontology.sql"

q(){ docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -tAc "$1"; }
adm(){ docker exec -i "$CONTAINER" psql -U "$PGUSER" -d postgres -c "$1"; }

echo "── Cloning '$SRC_DB' → '$SCRATCH' ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
adm "CREATE DATABASE $SCRATCH;" >/dev/null
docker exec -i "$CONTAINER" sh -c \
  "pg_dump -U $PGUSER -d $SRC_DB --no-owner --no-privileges | psql -U $PGUSER -d $SCRATCH -q" >/dev/null
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 < "$PROC" >/dev/null

echo "── Injecting a 2nd ontology + colliding 'Taxpayer' + $ROWS instances ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 >/dev/null <<SQL
DROP INDEX IF EXISTS uq_ontology_singleton;
DO \$f\$
DECLARE b uuid := '00000000-0000-0000-0000-0000000000fb'; bb uuid;
BEGIN
  INSERT INTO ontology (ontology_id, display_name, created_by) VALUES (b,'Batched Fixture','fixture');
  bb := uuid_generate_v5(uuid_ns_dns(), b::text || ':main');
  INSERT INTO ontology_branch (branch_id, ontology_id, name, status, created_by) VALUES (bb,b,'main','OPEN','fixture');
  INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, created_by)
    VALUES (gen_random_uuid(), b, 'Taxpayer', 'Taxpayer (fixture)', 'fixture');
  INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties)
    SELECT b, bb, 'Taxpayer', 'BX-'||g, '{}'::jsonb FROM generate_series(1, $ROWS) g;
END \$f\$;
SQL

PRE_INST=$(q "SELECT count(*) FROM object_instances;")
echo "   injected → ontologies=$(q "SELECT count(*) FROM ontology;") instances=$PRE_INST"

pass=0; fail=0
chk(){ if [[ "$2" == "$3" ]]; then printf '  \033[32mPASS\033[0m  %-44s (%s)\n' "$1" "$2"; pass=$((pass+1));
       else printf '  \033[31mFAIL\033[0m  %-44s got=%s want=%s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

echo "── GATE: low threshold must REFUSE ──"
adm "ALTER DATABASE $SCRATCH SET tellus.consolidation_inline_threshold = 100;" >/dev/null
GATE=$(docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 --single-transaction < "$MIGRATION" 2>&1 | grep -c "Refusing to auto-consolidate" || true)
chk "gate raises on large auto-merge" "$([[ "$GATE" -ge 1 ]] && echo yes || echo no)" "yes"
chk "gate left data untouched (2 ontologies)" "$(q "SELECT count(*) FROM ontology;")" "2"
adm "ALTER DATABASE $SCRATCH RESET tellus.consolidation_inline_threshold;" >/dev/null

echo "── BATCHED: CALL consolidate_single_ontology($BATCH) ──"
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -v ON_ERROR_STOP=1 \
  -c "CALL consolidate_single_ontology($BATCH);" >/dev/null
chk "folded into one ontology"           "$(q "SELECT count(*) FROM ontology;")" "1"
chk "no data loss"                       "$(q "SELECT count(*) FROM object_instances;")" "$PRE_INST"
chk "all instances on canonical"         "$(q "SELECT count(*) FROM object_instances WHERE ontology_id<>'$CANON';")" "0"
chk "collision renamed (2 Taxpayer*)"    "$(q "SELECT count(*) FROM object_type WHERE api_name LIKE 'Taxpayer%';")" "2"
chk "singleton guard present"            "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='uq_ontology_singleton';")" "1"

echo "── $pass passed, $fail failed ──"
adm "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null
[[ "$fail" -eq 0 ]] && echo "✅ Batched + gated consolidation verified ($ROWS rows, batch=$BATCH)."
[[ "$fail" -eq 0 ]]
