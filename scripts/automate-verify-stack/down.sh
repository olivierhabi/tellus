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

# 1. Stop the isolated API + FE by their recorded pids (best-effort), then
#    kill anything still bound to the verify ports as a safety net.
for name in api fe; do
  pidfile="/tmp/automate-verify-stack/$name.pid"
  [ -f "$pidfile" ] && kill -9 "$(cat "$pidfile")" 2>/dev/null && rm -f "$pidfile"
done
for p in "$VERIFY_API_PORT" "$VERIFY_FE_PORT"; do
  pid=$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null && echo "killed leftover process on :$p ($pid)"
done

set -a; . ./.env; set +a
PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD" tellus-postgres-1 psql -h localhost -p 5432 -U "$PGUSER" -d "$PGDATABASE" -tAc "$1"; }

# 2. Drop the isolated database ( forcibly disconnect any lingering conns).
if [ "$(PSQL "SELECT 1 FROM pg_database WHERE datname='$VERIFY_DB'")" = "1" ]; then
  PSQL "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$VERIFY_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  PSQL "DROP DATABASE IF EXISTS \"$VERIFY_DB\" WITH (FORCE)" >/dev/null 2>&1 || PSQL "DROP DATABASE \"$VERIFY_DB\"" >/dev/null 2>&1 || true
  echo "dropped DB $VERIFY_DB"
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

# 5. Purge the OpenSearch indices for the verify ontology's object types.
# down.sh drops the isolated PG database but the OpenSearch indices (shared
# OS container) are NOT dropped — docs authored during a prior verify run
# (the VerifyTaxpayer objects the E2E creates) survive a down/up cycle and
# pollute the next run's membership baseline (the baseline reads OS). Delete
# every `ontology-*` index whose `__ontology` is the verify ontology id so
# each run starts from a clean index matching the fresh DB.
VERIFY_ONTOLOGY="${VERIFY_ONTOLOGY:-00000000-0000-0000-0000-000000000001}"
curl -s -m 15 -X POST "http://localhost:9200/_search" -H 'Content-Type: application/json' \
  -d "{\"size\":0,\"query\":{\"term\":{\"__ontology\":\"$VERIFY_ONTOLOGY\"}},\"aggs\":{\"idx\":{\"terms\":{\"field\":\"_index\",\"size\":50}}}}" \
  | jq -r '.aggregations.idx.buckets[].key' 2>/dev/null | while read -r idx; do
      [ -n "$idx" ] && curl -s -m 15 -X DELETE "http://localhost:9200/$idx" -o /dev/null
    done
echo "purged OpenSearch indices for ontology $VERIFY_ONTOLOGY"

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
