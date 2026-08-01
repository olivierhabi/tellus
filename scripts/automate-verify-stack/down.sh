#!/usr/bin/env bash
# Tears down the ISOLATED Automate verification stack created by up.sh.
# Removes ONLY resources created by this stack (the isolated DB, realm,
# bucket, and the two processes on the verify ports) — never touches the
# shared dev servers or unrelated system processes.
#
#   bash scripts/automate-verify-stack/down.sh
set -uo pipefail
# $0 lives at <repo>/scripts/automate-verify-stack/down.sh → two levels up is
# the tellus repo root (where .env lives).
cd "$(dirname "$0")/../.."

set -a; . ./.env; set +a
set -a; . scripts/automate-verify-stack/stack.env; set +a

# --- 0b. DESTRUCTIVE GUARD: prove this teardown may destroy; abort early. ---
REPO_ROOT="$PWD"
./node_modules/.bin/tsx scripts/destructive-guard-cli.ts \
  --operation "down.sh-stack-teardown" --skip-api-probe \
  || { echo "REFUSED: env cannot prove this is a sealed, isolated verify stack — NOT destroying anything"; exit 1; }

# 1. Stop the isolated API + FE — WAIT FOR THE PROCESS TO ACTUALLY DIE.
# A pool with a live process keeps at-N connections open and our later DROP
# ALWAYS races it. The ONLY criterion: nothing listens on the ports and no
# pid in my stacks (=it's dead).
kill_process_on_port() {
  local port="$1" label="$2"
  local pp
  pp=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pp" ] && kill -9 "$pp" 2>/dev/null && echo "killed $label pid $pp on :$port"
}
for name in api fe; do
  pidfile="/tmp/automate-verify-stack/$name.pid"
  if [ -f "$pidfile" ]; then
    PPIDV=$(cat "$pidfile"); kill -9 "$PPIDV" 2>/dev/null; rm -f "$pidfile"
  fi
done
for p in "$VERIFY_API_PORT" "$VERIFY_FE_PORT"; do
  kill_process_on_port "$p" "stack"
done
sleep 3
# Only proceed once BOTH ports are free — never proceed with a zombie.
for p in "$VERIFY_API_PORT" "$VERIFY_FE_PORT"; do
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if [ -z "$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)" ]; then break; fi
    sleep 1
  done
  [ -z "$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)" ] || { echo "port $p still held after kill attempts — aborting"; exit 1; }
done

PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD" tellus-postgres-1 psql -h localhost -p 5432 -U "$PGUSER" -d "$PGDATABASE" -tAc "$1"; }
PSQL_MAINT() { docker exec -e PGPASSWORD="$PGPASSWORD" tellus-postgres-1 psql -h localhost -p 5432 -U "$PGUSER" -d postgres -tAc "$1"; }

# 2. Drop the isolated database — retry until no backend survives.
if [ "$(PSQL_MAINT "SELECT 1 FROM pg_database WHERE datname='$VERIFY_DB'")" = "1" ]; then
  PSQL_MAINT "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$VERIFY_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  sleep 1
  for attempt in 1 2 3 4 5; do
    if PSQL_MAINT "DROP DATABASE \"$VERIFY_DB\"" >/dev/null 2>&1; then
      echo "dropped DB $VERIFY_DB (attempt $attempt)"
      break
    fi
    echo "drop DATABASE attempt $attempt failed — waiting for backends to die"
    PSQL_MAINT "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$VERIFY_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    sleep 3
  done
  [ -z "$(PSQL_MAINT "SELECT 1 FROM pg_database WHERE datname='$VERIFY_DB'")" ] || { echo "DB $VERIFY_DB could NOT be dropped — aborting (stale data ≠ re-created fixture)"; exit 1; }
fi

# 3. Delete the isolated Keycloak realm.
KC="${KEYCLOAK_URL:-http://localhost:8086}"
KTOKEN=$(curl -sf -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KC_ADMIN_USER:-admin}&password=${KC_ADMIN_PASS:-admin}&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
if [ -n "$KTOKEN" ] && [ "$(curl -sf -H "Authorization: Bearer $KTOKEN" -o /dev/null -w '%{http_code}' "$KC/admin/realms/$VERIFY_REALM")" = "200" ]; then
  curl -sf -X DELETE -H "Authorization: Bearer $KTOKEN" "$KC/admin/realms/$VERIFY_REALM" -o /dev/null && echo "deleted realm $VERIFY_REALM"
fi

# 4. Delete the isolated MinIO bucket.
node -e "import('dotenv/config').then(async()=>{const{S3Client,ListObjectsV2Command,DeleteObjectCommand,DeleteBucketCommand}=await import('@aws-sdk/client-s3');const c=new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY},forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true'});async function empty(){let tok;do{const l=await c.send(new ListObjectsV2Command({Bucket:'$VERIFY_S3_BUCKET',ContinuationToken:tok}));for(const o of (l.Contents||[])){await c.send(new DeleteObjectCommand({Bucket:'$VERIFY_S3_BUCKET',Key:o.Key}))}tok=l.IsTruncated?l.NextContinuationToken:undefined}while(tok)}try{await empty();await c.send(new DeleteBucketCommand({Bucket:'$VERIFY_S3_BUCKET'}));console.log('bucket $VERIFY_S3_BUCKET deleted (emptied + removed)')}catch(e){console.log('bucket best-effort:',e.message||e)}})" 2>&1 | tail -1 || true

# 5. Purge this stack's OpenSearch data — name-scoped, NOT content-scoped.
# The canonical ontology id is SHARED across stacks (a single DB row holds
# the singleton), so term-scanning `__ontology` would claim DEV's indices
# too. The OS_INDEX_PREFIX discipline means verify's indices live under
# verify-ontology-*; the purge enumerates BY NAME and never disturbs dev.
OS_PREFIX="${OS_INDEX_PREFIX:-verify-main-ontology-}"
docker exec tellus-opensearch-1 curl -s -m 15 -X GET "http://localhost:9200/_cat/indices?h=index" 2>/dev/null \
  | awk '{print $1}' | grep -E "^${OS_PREFIX}" | while read -r idx; do
      [ -n "$idx" ] && curl -s -m 15 -X DELETE "http://localhost:9200/$idx" -o /dev/null         && echo "deleted index $idx"
    done
echo "purged ${OS_PREFIX}* OpenSearch indices"
# --- 6. Temporal namespace (FUNN-ISO cleanup policy). ---
# Ephemeral verify namespaces have a short history retention
# (VERIFY_TEMPORAL_RETENTION, default 72h) — TTL expiry is the documented
# cleanup mechanism since Temporal does not support namespace deletion.
# Before dropping the DB we TERMINATE open workflows so nothing keeps
# executing against a database that is about to disappear; closed history
# then expires via TTL.
TNS=$(docker ps --format '{{.Names}}' | grep -E '^tellus-temporal(-1)?$' | head -1 || true)
if [ -n "$TNS" ]; then
  ids=$(docker exec "$TNS" temporal workflow list --address temporal:7233 \
        --namespace "$TEMPORAL_NAMESPACE" --query "ExecutionStatus='Running'" --limit 200 2>/dev/null \
        | awk '{print $2}' | grep -v '^$' || true)
  term_count=0
  for wid in $ids; do
    # first column of `temporal workflow list` default output is WorkflowId
    docker exec "$TNS" temporal workflow terminate --address temporal:7233 \
      --namespace "$TEMPORAL_NAMESPACE" --workflow-id "$wid" \
      --reason "automate-verify down.sh (stack teardown)" >/dev/null 2>&1 \
      && term_count=$((term_count+1)) || true
  done
  echo "terminated $term_count running workflow(s) in namespace $TEMPORAL_NAMESPACE (closed history TTL-expires in $VERIFY_TEMPORAL_RETENTION)"
fi

rm -rf /tmp/automate-verify-stack
echo "=== automate-verify stack DOWN ==="
