#!/usr/bin/env bash
# Starts an ISOLATED Tellus Automate verification stack on dedicated ports
# against isolated PG / Keycloak-realm / MinIO-bucket namespaces. Never
# competes with the shared dev servers (:3000/:3001). Reproducible.
#
#   bash scripts/automate-verify-stack/up.sh
#
# Resources created (removed by down.sh):
#   - PostgreSQL DB  $VERIFY_DB in the shared tellus-postgres-1 container
#   - Keycloak realm $VERIFY_REALM (owner/admin/unauthorized users)
#   - MinIO bucket   $VERIFY_S3_BUCKET
#   - Tellus API on  :$VERIFY_API_PORT  (migrations applied to $VERIFY_DB)
#   - Next FE on      :$VERIFY_FE_PORT  (API URL → :$VERIFY_API_PORT)
set -uo pipefail
# $0 lives at <repo>/scripts/automate-verify-stack/up.sh → two levels up is the
# tellus repo root (where .env lives).
cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"
DETACH="$REPO_ROOT/scripts/automate-verify-stack/detach.sh"

set -a; . ./.env; set +a
set -a; . scripts/automate-verify-stack/stack.env; set +a

# --- 0. Race-proofing + port availability. —
# CI may run multiple instances of this script; an flock mutex protects the
# setup order, and namespaces derive deterministically from VERIFY_STACK_ID
# (no accidental sprawl — collision = same stack, same namespace). No
# partial-rollback needed: every piece below is idempotent.
mkdir -p /tmp/automate-verify-stack
exec 9>/tmp/automate-verify-stack/up.lock
flock -w 300 9 || { echo "another up.sh is running; lock stale > 300s"; exit 1; }
# --- 0b. Port availability — fail loudly instead of silently competing. ---
for p in "$VERIFY_API_PORT" "$VERIFY_FE_PORT"; do
  if [ -n "$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)" ]; then
    echo "ERROR: port $p is already in use (run scripts/automate-verify-stack/down.sh first or pick other ports)." >&2
    lsof -iTCP:"$p" -sTCP:LISTEN -P 2>/dev/null >&2
    exit 1
  fi
done
echo "ports $VERIFY_API_PORT (api) and $VERIFY_FE_PORT (fe) are free"

PSQL() { docker exec -e PGPASSWORD="$PGPASSWORD" tellus-postgres-1 psql -h localhost -p 5432 -U "$PGUSER" -d "$PGDATABASE" -tAc "$1"; }

# --- 1. Isolated PostgreSQL DB + migrations. ---
if [ "$(PSQL "SELECT 1 FROM pg_database WHERE datname='$VERIFY_DB'")" != "1" ]; then
  PSQL "CREATE DATABASE $VERIFY_DB" && echo "created DB $VERIFY_DB"
else
  echo "DB $VERIFY_DB already exists (idempotent)"
fi
PGDATABASE="$VERIFY_DB" pnpm migrate > /tmp/automate-verify-migrate.log 2>&1 || { echo "migration (run 1) failed (see /tmp/automate-verify-migrate.log)"; exit 1; }
# The canonical fresh-DB provisioning is migrate → foundry → auth → migrate
# (npm run migrate:all). The main migrator DEFERS forward migrations whose
# dependencies live in the Foundry/Compass track (e.g. 074 needs the `resources`
# table foundryMigrate creates); foundryMigrate creates those tables and
# applies the deferred tail, then the final migrate pass reapplies the
# inline 012-032 bootstrap blocks idempotently. Skipping this leaves 12
# migrations pending and the boot gate's auto-apply crashes on 074 ("relation
# resources does not exist"). Foundry/auth read PGUSER/PGPASSWORD/PGHOST from
# the sourced .env — they do not load dotenv themselves.
PGDATABASE="$VERIFY_DB" pnpm migrate:foundry > /tmp/automate-verify-foundry.log 2>&1 || { echo "migrate:foundry failed (see /tmp/automate-verify-foundry.log)"; tail -15 /tmp/automate-verify-foundry.log; exit 1; }
PGDATABASE="$VERIFY_DB" pnpm migrate:auth > /tmp/automate-verify-auth.log 2>&1 || { echo "migrate:auth failed (see /tmp/automate-verify-auth.log)"; tail -15 /tmp/automate-verify-auth.log; exit 1; }
PGDATABASE="$VERIFY_DB" pnpm migrate > /tmp/automate-verify-migrate2.log 2>&1 || { echo "migration (run 2) failed (see /tmp/automate-verify-migrate2.log)"; exit 1; }
echo "migrations applied to $VERIFY_DB (main + foundry + auth, 0 pending)"

# --- 2. Isolated Keycloak realm + clients + roles + users ----------------
# Wait for Keycloak readiness explicitly — a restarting/OOM-ing KC must
# never race the bootstrap (previously: realm created, hardening PUT → 000).
KC="${KEYCLOAK_URL:-http://localhost:8086}"
KC_OK=false
for i in $(seq 1 60); do
  if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$KC/realms/master" 2>/dev/null)" = "200" ]; then
    KC_OK=true; break
  fi
  sleep 2
done
if [ "$KC_OK" != "true" ]; then
  echo "ERROR: Keycloak at $KC not ready after 120s" >&2
  docker ps --filter name=keycloak --format '{{.Names}} {{.Status}}' >&2
  docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' 2>/dev/null | grep -i keycloak >&2
  exit 1
fi
echo "provisioning isolated realm $VERIFY_REALM (clients+roles+users)…"
KC_REALM="$VERIFY_REALM" \
KC_TEST_USER="$OWNER_EMAIL" \
KC_ADMIN_TEST_USER="$ADMIN_EMAIL" \
KC_NOGROUPS_TEST_USER="$UNAUTH_EMAIL" \
KC_TEST_PASS="$OWNER_PASS" \
  bash scripts/bootstrap-keycloak.sh > /tmp/automate-verify-kc.log 2>&1 \
  || { echo "ERROR: Keycloak bootstrap for $VERIFY_REALM failed (see /tmp/automate-verify-kc.log)"; tail -20 /tmp/automate-verify-kc.log; exit 1; }
# Resolve the provisioned user ids for downstream reporting/tests.
KTOKEN=$(curl -sf -X POST -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KC_ADMIN_USER:-admin}&password=${KC_ADMIN_PASS:-admin}&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
idof() { curl -sf -H "Authorization: Bearer $KTOKEN" "$KC/admin/realms/$VERIFY_REALM/users?username=$1" | jq -r '.[0].id // empty'; }
OWNER_ID=$(idof "$OWNER_EMAIL"); ADMIN_ID=$(idof "$ADMIN_EMAIL"); UNAUTH_ID=$(idof "$UNAUTH_EMAIL")
[ -n "$OWNER_ID" ] && [ -n "$ADMIN_ID" ] && [ -n "$UNAUTH_ID" ] \
  || { echo "ERROR: could not resolve verify-realm user ids (owner=$OWNER_ID admin=$ADMIN_ID unauth=$UNAUTH_ID)"; exit 1; }
echo "realm $VERIFY_REALM ready: owner=$OWNER_ID (ontology-editor) admin=$ADMIN_ID (ontology-admin) unauth=$UNAUTH_ID (no roles)"

# The Automate Function-effect runtime re-checks the owner via Keycloak by
# `sub` and the code-repository access check compares against the repo's
# `created_by` (the local users.id), so a non-superadmin HTTP owner of a
# Function automation is denied repo access on the identity mismatch (a
# pre-existing platform constraint — the shared dev stack's cypress users
# are tellus-superadmin for the same reason). Grant the isolated owner
# tellus-superadmin so the owner can create + run Function automations; the
# unauthorized user keeps zero roles so permission differentiation holds.
assign_super() { # $1 userId
  # bootstrap-keycloak.sh creates the ontology-* + marking:* roles but not
  # tellus-superadmin (the shared dev realm has it from historical seeding).
  # Create it idempotently in the isolated realm, then grant it to the owner.
  role_enc=$(printf '%s' "tellus-superadmin" | jq -sRr @uri)
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KTOKEN" "$KC/admin/realms/$VERIFY_REALM/roles/$role_enc")" != "200" ]; then
    curl -sf -X POST -H "Authorization: Bearer $KTOKEN" -H "Content-Type: application/json" \
      "$KC/admin/realms/$VERIFY_REALM/roles" -d '{"name":"tellus-superadmin","description":"Tellus superadmin (Function-automation owner access)"}' -o /dev/null
  fi
  rid=$(curl -sf -H "Authorization: Bearer $KTOKEN" "$KC/admin/realms/$VERIFY_REALM/roles/tellus-superadmin" | jq -r '.id // empty')
  if [ -z "$rid" ]; then echo "ERROR: tellus-superadmin role not found in realm $VERIFY_REALM" >&2; exit 1; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $KTOKEN" -H "Content-Type: application/json" \
    "$KC/admin/realms/$VERIFY_REALM/users/$1/role-mappings/realm" -d "[{\"id\":\"$rid\",\"name\":\"tellus-superadmin\"}]")
  if [ "$code" != "204" ] && [ "$code" != "200" ]; then echo "ERROR: failed to grant tellus-superadmin to $1 (HTTP $code)" >&2; exit 1; fi
}
assign_super "$OWNER_ID"
echo "owner $OWNER_ID granted tellus-superadmin (Function-automation owner access)"

# --- 2b. Isolated Temporal namespace (FUNN-ISO) — idempotent. ---
# Temporal namespaces are the isolation unit containing workflows + task
# queues; without this the verify worker polls the shared dev queue and
# Temporal freely dispatches dev activities into the verify database (the
# 2026-07-31 split-brain this stack exists to prevent). up.sh provisions
# the verify namespace idempotently; the API's worker bootstrap verifies
# the same name against `deployment_environment` in $VERIFY_DB.
TNS=$(docker ps --format '{{.Names}}' | grep -E '^tellus-temporal(-1)?$' | head -1 || true)
if [ -n "$TNS" ]; then
  if ! docker exec "$TNS" temporal operator namespace describe --address temporal:7233 "$TEMPORAL_NAMESPACE" >/dev/null 2>&1; then
    docker exec "$TNS" temporal operator namespace create --address temporal:7233 \
      --retention "$VERIFY_TEMPORAL_RETENTION" --description "automate-verify stack $VERIFY_STACK_ID (ephemeral)" \
      "$TEMPORAL_NAMESPACE" \
      && echo "created Temporal namespace $TEMPORAL_NAMESPACE (retention $VERIFY_TEMPORAL_RETENTION)"
  else
    echo "Temporal namespace $TEMPORAL_NAMESPACE exists (idempotent)"
  fi
  # Custom search attributes for funnel lineage — cluster-scoped, idempotent.
  for sa in TellusEnvironmentId TellusOntologyRid TellusObjectTypeRid TellusWorkerBuildId; do
    docker exec "$TNS" temporal operator search-attribute create --address temporal:7233 \
      --namespace "$TEMPORAL_NAMESPACE" --name "$sa" --type Keyword >/dev/null 2>&1 \
      && echo "  search attribute $sa registered" || true
  done
else
  echo "WARN: temporal container not found — API worker bootstrap will provision $TEMPORAL_NAMESPACE itself"
fi

# --- 3. Isolated MinIO bucket (best-effort; s3 client auto-creates too). ---
# Uses the tellus S3 creds from .env against the configured endpoint.
node -e "import('dotenv/config').then(async()=>{const{S3Client,CreateBucketCommand}=await import('@aws-sdk/client-s3');const c=new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY},forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true'});try{await c.send(new CreateBucketCommand({Bucket:'$VERIFY_S3_BUCKET'}));console.log('bucket $VERIFY_S3_BUCKET created')}catch(e){if(String(e).includes('BucketAlreadyOwnedByYou'))console.log('bucket exists');else console.log('bucket best-effort:',e.message||e)}})" 2>&1 | tail -2 || true

# --- 4. Start the isolated API on :VERIFY_API_PORT against the isolated env. ---
# detach.sh starts the daemon in its own session (portable setsid) so a
# killed/timed-out invoking shell cannot take the stack down with it
# (nohup alone only ignores SIGHUP, not a process-group SIGKILL).
mkdir -p /tmp/automate-verify-stack
( export PORT="$VERIFY_API_PORT" PGDATABASE="$VERIFY_DB" KEYCLOAK_REALM="$VERIFY_REALM" \
  S3_BUCKET="$VERIFY_S3_BUCKET" AUTOMATE_RUNTIME_DISABLED=false \
  CODE_REPOS_TEST_AUTH=0 TELLUS_TEST_HOOKS=1 \
  TELLUS_ENVIRONMENT_ID="$TELLUS_ENVIRONMENT_ID" \
  TEMPORAL_NAMESPACE="$TEMPORAL_NAMESPACE" \
  TEMPORAL_TASK_QUEUE="$TEMPORAL_TASK_QUEUE" \
  TEMPORAL_WORKER_BUILD_ID="$TEMPORAL_WORKER_BUILD_ID" \
  OS_INDEX_PREFIX="$OS_INDEX_PREFIX" \
  PG_CONNECT_TIMEOUT_MS=30000 PG_POOL_MAX=10 && \
  bash "$DETACH" /tmp/automate-verify-api.log /tmp/automate-verify-stack/api.pid pnpm exec tsx src/server.ts )
echo "starting isolated API on :$VERIFY_API_PORT (log /tmp/automate-verify-api.log)"
API_OK=false
for i in $(seq 1 120); do
  curl -s -m 2 -o /dev/null "http://localhost:$VERIFY_API_PORT/api/v1/health" && { echo "API healthy on :$VERIFY_API_PORT"; API_OK=true; break; }
  # Fail fast if the daemon died (OOM/crash) instead of waiting 240s.
  if ! kill -0 "$(cat /tmp/automate-verify-stack/api.pid 2>/dev/null)" 2>/dev/null; then
    echo "ERROR: isolated API process died during startup" >&2
    tail -20 /tmp/automate-verify-api.log >&2
    vm_stat | awk '/Pages free/{f=$3} END{print "free MB:", f*16384/1048576}' >&2
    docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}}' 2>/dev/null | head -8 >&2
    exit 1
  fi
  sleep 2
done
[ "$API_OK" = "true" ] || { echo "ERROR: API did not become healthy on :$VERIFY_API_PORT (see /tmp/automate-verify-api.log)" >&2; exit 1; }

# --- 5. Start the isolated FE on :VERIFY_FE_PORT pointing at the API. ---
# The frontend lives in the SIBLING tellus-fe repo (Next.js); this backend
# repo has no `next dev`. Launch the FE there with its BFF proxy pointing at
# the isolated API via TELLUS_BACKEND_ORIGIN. Leaving NEXT_PUBLIC_API_URL at
# its default (/api) routes the browser through the FE's own BFF on :3101,
# which proxies to TELLUS_BACKEND_ORIGIN (the isolated API on :3100).
FE_REPO="$(cd "$(dirname "$0")/../../.." && pwd)/tellus-fe"
if [ ! -d "$FE_REPO" ]; then
  echo "ERROR: frontend repo not found at $FE_REPO" >&2; exit 1
fi
echo "isolated FE uses next dev (development-only JIT compile)"
( cd "$FE_REPO" && \
  TELLUS_BACKEND_ORIGIN="http://localhost:$VERIFY_API_PORT" \
  CYPRESS_API_URL="http://localhost:$VERIFY_API_PORT/api" \
  NEXT_PUBLIC_API_URL="http://localhost:$VERIFY_API_PORT/api" \
  PORT="$VERIFY_FE_PORT" \
  bash "$DETACH" /tmp/automate-verify-fe.log /tmp/automate-verify-stack/fe.pid npx next dev -p "$VERIFY_FE_PORT" )
echo "starting isolated FE on :$VERIFY_FE_PORT from $FE_REPO (log /tmp/automate-verify-fe.log)"
FE_OK=false
for i in $(seq 1 90); do
  if curl -s -m 2 -o /dev/null "http://localhost:$VERIFY_FE_PORT/login"; then echo "FE healthy on :$VERIFY_FE_PORT"; FE_OK=true; break; fi
  sleep 2
done
[ "$FE_OK" = "true" ] || { echo "ERROR: FE did not become healthy on :$VERIFY_FE_PORT (see /tmp/automate-verify-fe.log)" >&2; exit 1; }

echo "=== automate-verify stack UP: api=:$VERIFY_API_PORT fe=:$VERIFY_FE_PORT db=$VERIFY_DB realm=$VERIFY_REALM bucket=$VERIFY_S3_BUCKET ==="

# --- 6. Deterministic isolated domain seed (objects/action/repo/fn v1-3). ---
# Runs against the live isolated API through REAL production paths only. Fail
# fast + loud (exit 1 with the failed step) so a broken seed never produces a
# false-green acceptance run. Idempotent — safe after an interrupted prior run.
echo "seeding isolated domain (objects/action-types/code-repo/fn v1-3)…"
cd "$REPO_ROOT"
PGDATABASE="$VERIFY_DB" KEYCLOAK_REALM="$VERIFY_REALM" S3_BUCKET="$VERIFY_S3_BUCKET" \
  VERIFY_API_PORT="$VERIFY_API_PORT" OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASS="$OWNER_PASS" \
  pnpm exec tsx scripts/automate-verify-stack/seed-domain.ts > /tmp/automate-verify-seed.log 2>&1 \
  || { echo "ERROR: isolated domain seed failed (see /tmp/automate-verify-seed.log)" >&2; tail -25 /tmp/automate-verify-seed.log >&2; exit 1; }
echo "isolated domain seeded (seed output /tmp/automate-verify-stack/seed.json)"
