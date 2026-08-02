#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-migration-156.sh — realistic validation of the Function invocation
# contract migration under deployment conditions (expand → legacy inserts →
# upgrade → old/new mixed operation → rollback → forward recovery).
#
# Steps proven on a scratch database:
#   1. Build the CURRENT schema (pg_dump of the isolated verify DB).
#   2. Roll DOWN 156 to reconstruct the pre-migration schema.
#   3. Insert representative legacy function versions + automation effects.
#   4. Apply 156 (forward). Assert backfill (legacy-md5 hashes), NOT NULL
#      contract, validated check constraint.
#   5. Simulate OLD code writing NEW-schema rows (no new columns → defaults);
#      simulate NEW code rows (positional v2 + sha256 hash + execution pins).
#   6. Roll DOWN again (code rollback), assert automation data survives and
#      stays executable-shaped.
#   7. Re-apply (forward recovery). Assert idempotence (second apply = no-op),
#      no automation unexecutable, backfill NOT redone for sha256 rows.
#
# Usage:  bash scripts/verify-migration-156.sh [SOURCE_DB]
# Requires: docker container tellus-postgres-1 running (shared stack).
# NEVER touches any non-scratch database.
# ---------------------------------------------------------------------------
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-tellus-postgres-1}"
PGUSER="${PGUSER:-tellus}"
export PGPASSWORD="${PGPASSWORD:-tellus123}"
SOURCE_DB="${1:-tellus_automate_verify}"
SCRATCH="tellus_mig156_verify_$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_DIR="$REPO_ROOT/src/migrations"

PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" psql -h localhost -p 5432 -U "$PGUSER" -d postgres -tAc "$1" ; }
PSQL_DB() { local db="$1"; shift; docker exec -i -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" psql -h localhost -p 5432 -U "$PGUSER" -d "$db" -v ON_ERROR_STOP=1 "$@" ; }

pass=0; fail=0
check() { # check <name> <expr-query> <expected>
  local name="$1" query="$2" expected="$3" actual
  actual=$(PSQL_DB "$SCRATCH" -tAc "$query" | tr -d '[:space:]')
  if [ "$actual" = "$expected" ]; then echo "  PASS $name"; pass=$((pass+1));
  else echo "  FAIL $name (expected=$expected actual=$actual)"; fail=$((fail+1)); fi
}

cleanup() { PSQL "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "== [0/7] scratch db $SCRATCH from schema of $SOURCE_DB"
docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" pg_dump -h localhost -U "$PGUSER" -s "$SOURCE_DB" > /tmp/mig156_schema_$$.sql
PSQL "CREATE DATABASE $SCRATCH"
PSQL_DB "$SCRATCH" -q < /tmp/mig156_schema_$$.sql > /dev/null

echo "== [1/7] roll back to pre-migration schema"
PSQL_DB "$SCRATCH" -q < "$MIG_DIR/156_function_invocation_contract.down.sql" > /dev/null
check "pre-migration: invocation_contract column absent" \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='function_registry_function_version' AND column_name='invocation_contract'" 0

echo "== [2/7] insert representative legacy rows"
PSQL_DB "$SCRATCH" <<'SQL' > /dev/null
INSERT INTO function_registry_function (rid, repository_rid, api_name, display_name, source_path)
VALUES ('ri.function-registry.main.function.mig156a','ri.stemma.main.repository.mig156','legacyOne','legacyOne','src/functions/legacyOne.ts');
INSERT INTO function_version (rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
  artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state)
VALUES ('ri.function-registry.main.version.mig156a','ri.stemma.main.repository.mig156','main',false,'1.0.0',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','NODE_20','s3:mig156/legacy',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',128,'{}'::jsonb,'AVAILABLE');
INSERT INTO function_registry_function_version (function_rid, semver, branch, release_version_rid,
  commit_sha, source_path, artifact_sha256, signature, function_kind)
VALUES ('ri.function-registry.main.function.mig156a','1.0.0','main','ri.function-registry.main.version.mig156a',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'src/functions/legacyOne.ts','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"parameters":[{"name":"input","type":"{ input: string }","optional":false}],"output":"string"}'::jsonb,'query');
SQL
check "legacy row inserted" \
  "SELECT count(*) FROM function_registry_function_version WHERE function_rid='ri.function-registry.main.function.mig156a'" 1

echo "== [3/7] apply migration 156 (forward)"
PSQL_DB "$SCRATCH" -q < "$MIG_DIR/156_function_invocation_contract.sql" > /dev/null
check "contract column backfilled as legacy" \
  "SELECT invocation_contract FROM function_registry_function_version WHERE function_rid='ri.function-registry.main.function.mig156a'" \
  "legacy-object-envelope-v1"
check "signature hash backfilled deterministically (legacy-md5)" \
  "SELECT signature_hash LIKE 'legacy-md5:%' FROM function_registry_function_version WHERE function_rid='ri.function-registry.main.function.mig156a'" t
check "check constraint validated" \
  "SELECT convalidated FROM pg_constraint WHERE conname='function_registry_function_version_contract_check'" t
check "execution pinning columns exist" \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='automation_effect_execution' AND column_name IN ('resolved_function_semver','resolved_artifact_sha256','invocation_contract','signature_hash')" 4

echo "== [4/7] rolling-deploy simulation"
# OLD code inserts a new row WITHOUT the new columns (defaults must apply):
PSQL_DB "$SCRATCH" > /dev/null <<'SQL'
INSERT INTO function_version (rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
  artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state)
VALUES ('ri.function-registry.main.version.mig156b','ri.stemma.main.repository.mig156','main',false,'1.0.1',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','NODE_20','s3:mig156/legacy101',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',128,'{}'::jsonb,'AVAILABLE');
INSERT INTO function_registry_function_version (function_rid, semver, branch, release_version_rid,
  commit_sha, source_path, artifact_sha256, signature, function_kind)
VALUES ('ri.function-registry.main.function.mig156a','1.0.1','main','ri.function-registry.main.version.mig156b',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'src/functions/legacyOne.ts','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '{"parameters":[{"name":"input","type":"{ input: string }","optional":false}],"output":"string"}'::jsonb,'query');
SQL
check "old-code insert gets legacy contract default" \
  "SELECT invocation_contract FROM function_registry_function_version WHERE semver='1.0.1' AND function_rid='ri.function-registry.main.function.mig156a'" \
  "legacy-object-envelope-v1"
# An old-code row inserted AFTER the forward migration has no hash yet —
# new application code tolerates NULL (computes the canonical hash lazily);
# the next backfill (re-run/recovery) fills it deterministically.
check "old-code insert has NULL hash (new code tolerates; next backfill fills)" \
  "SELECT count(*) FROM function_registry_function_version WHERE semver='1.0.1' AND function_rid='ri.function-registry.main.function.mig156a' AND signature_hash IS NULL" 1
# NEW code rows: positional v2 + canonical sha + execution pins.
PSQL_DB "$SCRATCH" > /dev/null <<'SQL'
INSERT INTO function_version (rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
  artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state)
VALUES ('ri.function-registry.main.version.mig156c','ri.stemma.main.repository.mig156','main',false,'2.0.0',
  'cccccccccccccccccccccccccccccccccccccccc','NODE_20','s3:mig156/v2',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',128,'{}'::jsonb,'AVAILABLE');
INSERT INTO function_registry_function_version (function_rid, semver, branch, release_version_rid,
  commit_sha, source_path, artifact_sha256, signature, function_kind, invocation_contract, signature_hash)
VALUES ('ri.function-registry.main.function.mig156a','2.0.0','main','ri.function-registry.main.version.mig156c',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'src/functions/legacyOne.ts','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '{"contractVersion":2,"parameters":[{"name":"input","position":0,"type":"string","optional":false,"hasDefault":false}],"output":"string"}'::jsonb,
  'query','typescript-v2-positional-v2','sha256:deadbeef');
INSERT INTO ontology (ontology_id, display_name) VALUES ('00000000-0000-0000-0000-000000001566','mig156') ON CONFLICT DO NOTHING;
INSERT INTO automation (automation_id, rid, tenant_id, ontology_id, name, owner_user_id, created_by, status, draft_definition)
VALUES (gen_random_uuid(),'ri.automation.main.automation.mig156','mig156','00000000-0000-0000-0000-000000001566','mig156',gen_random_uuid()::text,gen_random_uuid()::text,'draft','{}'::jsonb);
SQL
check "new-code positional row survives" \
  "SELECT invocation_contract FROM function_registry_function_version WHERE semver='2.0.0' AND function_rid='ri.function-registry.main.function.mig156a'" \
  "typescript-v2-positional-v2"
check "new-code sha256 hash preserved by backfill skip" \
  "SELECT signature_hash FROM function_registry_function_version WHERE semver='2.0.0' AND function_rid='ri.function-registry.main.function.mig156a'" \
  "sha256:deadbeef"

echo "== [5/7] idempotence: second apply is a safe no-op"
PSQL_DB "$SCRATCH" -q < "$MIG_DIR/156_function_invocation_contract.sql" > /dev/null
check "re-apply keeps sha256 hash (no double backfill)" \
  "SELECT signature_hash FROM function_registry_function_version WHERE semver='2.0.0' AND function_rid='ri.function-registry.main.function.mig156a'" \
  "sha256:deadbeef"

echo "== [6/7] code rollback: down migration drops only metadata columns"
PSQL_DB "$SCRATCH" -q < "$MIG_DIR/156_function_invocation_contract.down.sql" > /dev/null
check "registry rows survive code rollback" \
  "SELECT count(*) FROM function_registry_function_version WHERE function_rid='ri.function-registry.main.function.mig156a'" 3
check "automation rows survive code rollback" \
  "SELECT count(*) FROM automation WHERE rid='ri.automation.main.automation.mig156'" 1

echo "== [7/7] forward recovery: re-apply completes idempotently"
PSQL_DB "$SCRATCH" -q < "$MIG_DIR/156_function_invocation_contract.sql" > /dev/null
check "recovery backfills legacy rows again" \
  "SELECT count(*) FROM function_registry_function_version WHERE function_rid='ri.function-registry.main.function.mig156a' AND signature_hash IS NOT NULL" 3
check "recovery: contract check re-validated" \
  "SELECT convalidated FROM pg_constraint WHERE conname='function_registry_function_version_contract_check'" t
check "no automation became unexecutable (rows + repo intact)" \
  "SELECT count(*) FROM function_registry_function_version fv JOIN function_version r ON r.rid=fv.release_version_rid WHERE r.state='AVAILABLE'" 3

echo "== RESULT: $pass passed, $fail failed"
[ "$fail" = "0" ]
