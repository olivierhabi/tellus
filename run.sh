#!/usr/bin/env bash
# =============================================================================
# run.sh — bring up the Tellus backend and every service it depends on.
#
# Single source of truth: the project's docker-compose.yml. This wrapper adds
# the operational guarantees a bare `docker compose up` does not:
#   * fail-fast preflight (daemon reachable, compose v2, files present)
#   * deterministic project name so it always manages the SAME stack
#   * builds the app image, then BLOCKS until every healthchecked service is
#     actually healthy (not merely "started") — so a green exit means ready
#   * a clear endpoint/status summary, and a non-zero exit on timeout
#
# Usage:
#   ./run.sh                 # build + start everything, wait for healthy
#   ./run.sh --core          # DEV DAILY-DRIVER: start ONLY the core infra the
#                            # host backend (`pnpm dev`) needs — postgres,
#                            # opensearch, keycloak, minio (+minio-init).
#                            # Skips kafka/zk, clickhouse, redis, temporal,
#                            # lakekeeper and the containerised `app`: the app
#                            # tolerates all of them being down (in-memory /
#                            # PG fallbacks; verify with `docker compose ... ps`).
#   ./run.sh --no-build      # start without rebuilding the app image
#   ./run.sh --pull          # pull newer base images before building
#   ./run.sh --recreate      # force-recreate containers
#   ./run.sh --no-wait       # start in background, don't block on health
#   ./run.sh --no-bootstrap  # skip the post-up bootstrap (migrations, realm,
#                            # superadmin, passkey gate) — just up + health
#   ./run.sh --logs          # tail app logs after it becomes healthy (full mode)
#   ./run.sh -h | --help
#
# Service-subset override: set RUN_SERVICES to a space-separated service list
# (e.g. RUN_SERVICES="postgres keycloak opensearch minio redis clickhouse")
# to bring up exactly that set instead of the full stack or the --core set.
#
# Overridable via env: COMPOSE_FILE, PROJECT_NAME, ENV_FILE, HEALTH_TIMEOUT,
# RUN_BOOTSTRAP (default 1; set 0 to skip the bootstrap phase), RUN_SERVICES.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

# --- locate ourselves so the script works from any CWD -----------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
cd -- "$SCRIPT_DIR"

# --- configuration (env-overridable) -----------------------------------------
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PROJECT_NAME="${PROJECT_NAME:-tellus}"
ENV_FILE="${ENV_FILE:-.env}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"   # seconds to wait for full health
HEALTH_POLL="${HEALTH_POLL:-5}"           # poll interval, seconds

# --- flags -------------------------------------------------------------------
DO_BUILD=1; DO_PULL=0; RECREATE=0; WAIT=1; FOLLOW_LOGS=0
DO_BOOTSTRAP="${RUN_BOOTSTRAP:-1}"
MODE="${RUN_MODE:-full}"

# Daily-driver dev core (2026-08-13 container-diet pass): the only infra the
# host backend (`pnpm dev`/nodemon) hard-requires. Everything else the app
# degrades around (redis→in-memory, clickhouse→PG, temporal→PG dispatcher,
# lakekeeper→PG shim, kafka→events dropped harmlessly, and schema-registry /
# autoheal / mem-monitor / pg-backup were removed from the default stack
# having no code usage at all).
# shellcheck disable=SC2206
CORE_SERVICES=(postgres opensearch keycloak minio minio-init)

# --- pretty logging (auto-disabled when not a TTY or NO_COLOR set) ------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RST=$'\033[0m'; C_INF=$'\033[36m'; C_OK=$'\033[32m'; C_WRN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RST=""; C_INF=""; C_OK=""; C_WRN=""; C_ERR=""
fi
# Join an array into a single space-separated line for display (IFS is \n\t,
# so "${arr[*]}" would otherwise show one element per line).
as_line() { local IFS=' '; echo "$*"; }
# Read a single value from ENV_FILE (first match). Used so the bootstrap
# phase sees the same creds the compose --env-file passes to the containers,
# without sourcing .env (which may contain non-shell-safe lines).
env_val() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  # grep returns 1 on no-match; under `set -e`+pipefail that would kill the
  # script when a key is legitimately absent (e.g. KEYCLOAK_REALM, NODE_ENV).
  # Always return 0 so callers can safely use the `${var:-default}` pattern.
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}
ts()   { date +'%H:%M:%S'; }
log()  { printf '%s %s[run]%s %s\n'  "$(ts)" "$C_INF" "$C_RST" "$*"; }
ok()   { printf '%s %s[ ok]%s %s\n'  "$(ts)" "$C_OK"  "$C_RST" "$*"; }
warn() { printf '%s %s[warn]%s %s\n' "$(ts)" "$C_WRN" "$C_RST" "$*" >&2; }
die()  { printf '%s %s[err]%s %s\n'  "$(ts)" "$C_ERR" "$C_RST" "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO (exit $?). Stack left as-is; inspect with: docker compose -p '"$PROJECT_NAME"' ps"' ERR

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# --- parse args --------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --core)      MODE=core ;;
    --no-build)  DO_BUILD=0 ;;
    --pull)      DO_PULL=1 ;;
    --recreate)  RECREATE=1 ;;
    --no-wait)   WAIT=0 ;;
    --no-bootstrap) DO_BOOTSTRAP=0 ;;
    --logs)      FOLLOW_LOGS=1 ;;
    -h|--help)   usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# Compose invocation, fixed for every call so we never touch a different stack.
COMPOSE=(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

# --- preflight ---------------------------------------------------------------
preflight() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin not found ('docker compose')"
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable — is Docker running?"
  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
  if [[ ! -f "$ENV_FILE" ]]; then
    warn "$ENV_FILE not found — services will fall back to compose defaults."
  fi
  # Validate compose syntax before doing anything mutating.
  "${COMPOSE[@]}" config -q || die "compose file failed validation (see errors above)"
  ok "preflight passed (project=$PROJECT_NAME, file=$COMPOSE_FILE)"
}

# --- health gate -------------------------------------------------------------
# Ready := running AND (no healthcheck OR health=healthy). Returns when all
# containers are ready, or exits non-zero on timeout (printing the laggards).
wait_for_health() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  log "waiting up to ${HEALTH_TIMEOUT}s for all services to become healthy…"
  while :; do
    local ids; ids="$("${COMPOSE[@]}" ps -q)"
    [[ -n "$ids" ]] || { warn "no containers running yet…"; }

    local total=0 ready=0 pending=()
    local id name state health
    while IFS= read -r id; do
      [[ -z "$id" ]] && continue
      total=$((total+1))
      name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
      state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)"
      health="$(docker inspect -f '{{if .Config.Healthcheck}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)"
      if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
        ready=$((ready+1))
      elif [[ "$state" == "exited" && "$health" == "none" ]]; then
        # one-shot init containers (e.g. *-init, *-migrate, *-bootstrap) exit 0 by design
        local rc; rc="$(docker inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null || echo 1)"
        if [[ "$rc" == "0" ]]; then ready=$((ready+1)); else pending+=("$name=exited($rc)"); fi
      else
        pending+=("$name=$state/$health")
      fi
    done <<< "$ids"

    if [[ $total -gt 0 && $ready -eq $total ]]; then
      ok "all $total containers ready"
      return 0
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      warn "timeout: $ready/$total ready. Not-ready: ${pending[*]:-none}"
      die "stack did not become healthy within ${HEALTH_TIMEOUT}s — inspect with: $(as_line "${COMPOSE[@]}") ps"
    fi
    printf '%s %s[..]%s %d/%d ready — pending: %s\n' "$(ts)" "$C_INF" "$C_RST" "$ready" "$total" "${pending[*]:-…}"
    sleep "$HEALTH_POLL"
  done
}

# --- single-service health gate ----------------------------------------------
# Polls ONE service's container until it is running+healthy (or no healthcheck).
# The bootstrap phase needs postgres + keycloak ready BEFORE it can run
# migrations / create the realm, even while the `app` container is still
# crash-looping on a missing schema.
wait_for_service_healthy() {
  local svc="$1" timeout="${2:-120}"
  local deadline=$(( $(date +%s) + timeout ))
  log "waiting up to ${timeout}s for $svc to become healthy…"
  while :; do
    local id; id="$("${COMPOSE[@]}" ps -q -a "$svc" 2>/dev/null | head -1 || true)"
    if [[ -n "$id" ]]; then
      local state health
      state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)"
      health="$(docker inspect -f '{{if .Config.Healthcheck}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)"
      if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
        ok "$svc is ready"
        return 0
      elif [[ "$state" == "exited" && "$health" == "none" ]]; then
        # One-shot containers (*-init, *-migrate, *-bootstrap) exit by design.
        local rc; rc="$(docker inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null || echo 1)"
        if [[ "$rc" == "0" ]]; then ok "$svc is ready (one-shot, exited 0)"; return 0
        else die "$svc exited with rc=$rc"; fi
      fi
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      die "timeout: $svc did not become healthy within ${timeout}s"
    fi
    sleep "$HEALTH_POLL"
  done
}

# --- post-up bootstrap (idempotent) ------------------------------------------
# A bare `docker compose up` leaves a fresh Tellus stack unusable: the app
# container runs `node dist/server.js` directly (no auto-migrate), the
# Keycloak `tellus` realm does not exist, and `require_passkey_enrollment`
# defaults to true (so first login returns an enrollment token instead of
# session cookies). This phase fills those gaps in one go. Every step is
# guarded so re-running run.sh on an already-bootstrapped stack is a no-op.
#
# Steps (in order; each safe to repeat):
#   1. sync the postgres user password to .env (trust socket — fixes the
#      volume-initialized-with-a-different-PGPASSWORD reconfiguration case)
#   2. run the three migration scripts if the schema ledger is missing
#   3. (app is restarted so its migration gate passes)
#   4. bootstrap the Keycloak `tellus` realm if absent
#   5. ensure the superadmin user exists in Keycloak (mode-agnostic — works
#      even when the app runs in production mode and skips auto-create)
#   6. (app restarted once if the user was freshly created, so its bootstrap
#      grants the tellus-superadmin realm role)
#   7. disable require_passkey_enrollment when ENVIRONMENT=development

# Escape a string for safe embedding in a single-quoted SQL literal.
sql_quote() { local s="$1"; s="${s//\'/\'\'}"; printf "'%s'" "$s"; }

bootstrap_sync_pg_password() {
  local pguser pgdb pgpw
  pguser="$(env_val PGUSER)"; pguser="${pguser:-tellus}"
  pgdb="$(env_val PGDATABASE)"; pgdb="${pgdb:-tellus_db}"
  pgpw="$(env_val PGPASSWORD)"; pgpw="${pgpw:-changeme}"
  # `exec … psql -U <user>` inside the official postgres image uses the
  # local unix socket which is `trust` by default — no password needed to
  # issue ALTER USER, so this works even when the volume's current password
  # does not yet match .env. Idempotent.
  local q; q=$(sql_quote "$pgpw")
  if "${COMPOSE[@]}" exec -T postgres psql -U "$pguser" -d "$pgdb" \
        -c "ALTER USER \"${pguser}\" WITH PASSWORD ${q};" >/dev/null 2>&1; then
    ok "postgres password synced to .env ($pguser)"
  else
    warn "postgres password sync failed — if the app cannot connect, set .env PGPASSWORD to the volume's initial password"
  fi
}

# Detect a fresh database by the absence of the migration ledger table.
# The three migration scripts ship inside the app image (dist/migrate.js,
# dist/foundryMigrate.js, dist/migrateAuth.js) and are run via `compose run`
# so they inherit the app service env (PGHOST=postgres, etc.) and network.
bootstrap_run_migrations() {
  local pguser pgdb
  pguser="$(env_val PGUSER)"; pguser="${pguser:-tellus}"
  pgdb="$(env_val PGDATABASE)"; pgdb="${pgdb:-tellus_db}"
  local marker
  marker="$("${COMPOSE[@]}" exec -T postgres psql -U "$pguser" -d "$pgdb" \
            -tAc "SELECT to_regclass('schema_migrations_applied')" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$marker" == "schema_migrations_applied" ]]; then
    ok "schema ledger present — skipping migrations"
    return 0
  fi
  log "fresh database — running migrations…"
  "${COMPOSE[@]}" run -T --rm --no-deps app node dist/migrate.js >/dev/null 2>&1 \
    || die "core migrations failed (dist/migrate.js)"
  "${COMPOSE[@]}" run -T --rm --no-deps app node dist/foundryMigrate.js >/dev/null 2>&1 \
    || die "foundry migrations failed (dist/foundryMigrate.js)"
  "${COMPOSE[@]}" run -T --rm --no-deps app node dist/migrateAuth.js >/dev/null 2>&1 \
    || die "auth migrations failed (dist/migrateAuth.js)"
  ok "all migrations applied"
}

# Bring the `tellus` realm up to spec via the project's own idempotent script.
# Skipped if the realm already exists (checked via an unauthenticated GET).
bootstrap_keycloak_realm() {
  local kc_realm kc_port kc_url
  kc_realm="$(env_val KEYCLOAK_REALM)"; kc_realm="${kc_realm:-tellus}"
  # Derive the keycloak host port from THIS project's compose config.
  # `|| true` group INSIDE the substitution: a missing/stopped keycloak
  # service is an EXPECTED state (e.g. hosted by the per-suffix verify
  # project) and must not trip the ERR trap in the subshell with a scary
  # "[err] failed at line".
  kc_port="$({ "${COMPOSE[@]}" port keycloak 8086 2>/dev/null || true; } | sed 's/.*://')" || kc_port=""
  kc_port="${kc_port:-8086}"
  kc_url="http://127.0.0.1:${kc_port}"
  if curl -sf "${kc_url}/realms/${kc_realm}" -o /dev/null 2>&1; then
    ok "keycloak realm '${kc_realm}' already exists"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found — skipping keycloak realm bootstrap (install jq and re-run)"
    return 0
  fi
  log "bootstrapping keycloak realm '${kc_realm}'…"
  KC_URL="$kc_url" bash "$SCRIPT_DIR/scripts/bootstrap-keycloak.sh" >/dev/null 2>&1 \
    || die "keycloak realm bootstrap failed (scripts/bootstrap-keycloak.sh)"
  # Relax the password policy for dev deployments (the bootstrap script sets
  # length(12); dev superadmin passwords like "Elie0?Telos" are 11 chars).
  # Authenticate as the Keycloak master admin using THIS project's .env
  # credentials. Hardcoding admin/admin (the old behaviour) makes this
  # unreachable on any deployment that sets KEYCLOAK_ADMIN_PASSWORD — which
  # docker-compose.yml REQUIRES — so the realm/superadmin bootstrap silently
  # degraded to a warning. Read the creds; fall back to admin/admin only when
  # unset, preserving the historical default.
  local kc_admin_user kc_admin_pass
  kc_admin_user="$(env_val KEYCLOAK_ADMIN)"; kc_admin_user="${kc_admin_user:-admin}"
  kc_admin_pass="$(env_val KEYCLOAK_ADMIN_PASSWORD)"; kc_admin_pass="${kc_admin_pass:-admin}"
  local tok; tok="$(curl -sf "${kc_url}/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    -d username="$kc_admin_user" -d password="$kc_admin_pass" 2>/dev/null | jq -r '.access_token // empty')" || true
  if [[ -n "$tok" ]]; then
    local rj; rj="$(curl -sf "${kc_url}/admin/realms/${kc_realm}" -H "Authorization: Bearer ${tok}" 2>/dev/null)" || true
    if [[ -n "$rj" ]]; then
      curl -sf -X PUT "${kc_url}/admin/realms/${kc_realm}" -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \
        -d "$(echo "$rj" | jq '.passwordPolicy="length(8) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername(undefined)"')" \
        -o /dev/null 2>&1 || true
    fi
  fi
  ok "keycloak realm '${kc_realm}' created (password policy relaxed for dev)"
}

# Ensure the superadmin user exists in Keycloak. Mode-agnostic: works whether
# the app is in development (auto-create) or production (skip). Clears the
# CONFIGURE_TOTP required action so first login is not MFA-gated.
bootstrap_ensure_superadmin() {
  local email pw
  email="$(env_val TELLUS_SUPERADMIN_EMAIL)"
  pw="$(env_val TELLUS_SUPERADMIN_PASSWORD)"
  if [[ -z "$email" || -z "$pw" ]]; then
    warn "TELLUS_SUPERADMIN_EMAIL/PASSWORD not set in $ENV_FILE — skipping superadmin user"
    SUPERADMIN_CREATED=0
    return 0
  fi
  command -v jq >/dev/null 2>&1 || { warn "jq not found — skipping superadmin ensure"; SUPERADMIN_CREATED=0; return 0; }
  local kc_realm kc_port kc_url
  kc_realm="$(env_val KEYCLOAK_REALM)"; kc_realm="${kc_realm:-tellus}"
  # Derive the keycloak host port from THIS project's compose config so the
  # bootstrap works for any project (Elie: 8086, Sam: 8087, etc.).
  # `|| true` group INSIDE the substitution: a missing/stopped keycloak
  # service is an EXPECTED state (e.g. hosted by the per-suffix verify
  # project) and must not trip the ERR trap in the subshell with a scary
  # "[err] failed at line".
  kc_port="$({ "${COMPOSE[@]}" port keycloak 8086 2>/dev/null || true; } | sed 's/.*://')" || kc_port=""
  kc_port="${kc_port:-8086}"
  kc_url="http://127.0.0.1:${kc_port}"
  local kc_admin_user kc_admin_pass
  kc_admin_user="$(env_val KEYCLOAK_ADMIN)"; kc_admin_user="${kc_admin_user:-admin}"
  kc_admin_pass="$(env_val KEYCLOAK_ADMIN_PASSWORD)"; kc_admin_pass="${kc_admin_pass:-admin}"
  local tok
  tok="$(curl -sf "${kc_url}/realms/master/protocol/openid-connect/token" \
          -d grant_type=password -d client_id=admin-cli \
          -d username="$kc_admin_user" -d password="$kc_admin_pass" 2>/dev/null | jq -r '.access_token // empty')" || true
  if [[ -z "$tok" ]]; then
    warn "keycloak admin token exchange failed — skipping superadmin ensure"
    SUPERADMIN_CREATED=0
    return 0
  fi
  local userid
  userid="$(curl -sf "${kc_url}/admin/realms/${kc_realm}/users?username=${email}" \
            -H "Authorization: Bearer ${tok}" 2>/dev/null | jq -r '.[0].id // empty')" || true
  if [[ -z "$userid" ]]; then
    log "creating superadmin user ${email}…"
    # Keycloak 25 IGNORES the `credentials` array on POST /users (and a
    # broken credential record blocks the subsequent reset-password). The
    # working method — used by scripts/bootstrap-keycloak.sh — is to create
    # the user with NO credentials, then set the password via PUT reset-password.
    curl -sf -X POST "${kc_url}/admin/realms/${kc_realm}/users" \
      -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \
      -d "$(jq -n --arg e "$email" '{username:$e,email:$e,enabled:true,emailVerified:true,firstName:"Tellus",lastName:"Administrator"}')" \
      -o /dev/null 2>&1 || die "superadmin user creation failed"
    userid="$(curl -sf "${kc_url}/admin/realms/${kc_realm}/users?username=${email}" \
              -H "Authorization: Bearer ${tok}" 2>/dev/null | jq -r '.[0].id // empty')"
    SUPERADMIN_CREATED=1
  else
    ok "superadmin user already exists (${email})"
    SUPERADMIN_CREATED=0
  fi
  # Always (re)set the password via reset-password — idempotent reconcile to
  # .env, matches the app's own "[bootstrap] reconciled superadmin password".
  local body; body="$(jq -n --arg p "$pw" '{type:"password",value:$p,temporary:false}')"
  curl -sf -X PUT "${kc_url}/admin/realms/${kc_realm}/users/${userid}/reset-password" \
    -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \
    -d "$body" -o /dev/null 2>&1 \
    || warn "superadmin reset-password failed — login may not work until the app reconciles it"
  # Grant ontology-admin (the realm's admin role from bootstrap-keycloak.sh).
  local roleid
  roleid="$(curl -sf "${kc_url}/admin/realms/${kc_realm}/roles/ontology-admin" \
            -H "Authorization: Bearer ${tok}" 2>/dev/null | jq -r '.id // empty')" || true
  if [[ -n "$roleid" ]]; then
    curl -sf -X POST "${kc_url}/admin/realms/${kc_realm}/users/${userid}/role-mappings/realm" \
      -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \
      -d "[{\"id\":\"${roleid}\",\"name\":\"ontology-admin\"}]" -o /dev/null 2>&1 || true
  fi
  # Clear mandatory required actions so the first direct-grant login succeeds.
  curl -sf -X PUT "${kc_url}/admin/realms/${kc_realm}/users/${userid}" \
    -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \
    -d '{"requiredActions":[]}' -o /dev/null 2>&1 || true
  ok "superadmin ready (${email})"
}

# In development, disable the mandatory-passkey gate so the first login sets
# session cookies instead of returning an enrollment token. Skipped in
# production (it is a security policy there).
bootstrap_disable_passkey_gate() {
  local env_node
  env_node="$(env_val ENVIRONMENT)"; env_node="${env_node:-$(env_val NODE_ENV)}"
  env_node="${env_node:-production}"
  if [[ "$env_node" != "development" ]]; then
    log "ENVIRONMENT=${env_node} — keeping require_passkey_enrollment=true (production policy)"
    return 0
  fi
  local pguser pgdb
  pguser="$(env_val PGUSER)"; pguser="${pguser:-tellus}"
  pgdb="$(env_val PGDATABASE)"; pgdb="${pgdb:-tellus_db}"
  # system_settings is created by the auth migrations; the row is seeded by
  # the app on boot. Idempotent upsert guards both cases.
  "${COMPOSE[@]}" exec -T postgres psql -U "$pguser" -d "$pgdb" \
    -c "INSERT INTO system_settings (key, value) VALUES ('require_passkey_enrollment', 'false'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb;" >/dev/null 2>&1 \
    || warn "could not set require_passkey_enrollment=false (non-fatal; login may require passkey enrollment)"
  ok "require_passkey_enrollment=false (development)"
}

# --- Temporal Build-ID routing rule ------------------------------------------
# Worker versioning (server 1.25) requires an assignment rule routing the
# task queue to the worker's build-id; with no rule, the execution router
# has no target and the funnel worker refuses to boot in strict mode
# (`task queue '...' does NOT route to build '...'`). The app's own
# `ensureQueueAssignmentRule` self-provisions in non-strict mode but
# strict mode (NODE_ENV=production) forbids it — deployment infrastructure
# owns the rule. This is that infrastructure. Idempotent: if a rule for the
# build already exists, this is a no-op.
#
# The build-id is resolved identically to src/config/environmentIdentity.ts:
#   TEMPORAL_WORKER_BUILD_ID env > `git rev-parse --short=12 HEAD` > "dev".
# The Docker image has no .git, so the fallback is "dev" unless the env
# overrides it. We read TEMPORAL_WORKER_BUILD_ID from .env (the same value
# the compose --env-file passes to the app container).
bootstrap_temporal_versioning() {
  local ns queue build_id
  ns="$(env_val TEMPORAL_NAMESPACE)"; ns="${ns:-tellus-funnel-tellus-dev}"
  queue="$(env_val TEMPORAL_TASK_QUEUE)"; queue="${queue:-tellus-funnel-queue-tellus-dev}"
  build_id="$(env_val TEMPORAL_WORKER_BUILD_ID)"; build_id="${build_id:-dev}"
  # The temporal CLI lives inside the temporal container; the app image
  # does not ship it. Use `compose exec` so it targets THIS project's
  # temporal container (not another stack's).
  if ! "${COMPOSE[@]}" exec -T temporal temporal --version >/dev/null 2>&1; then
    warn "temporal CLI not found in ${PROJECT_NAME}-temporal-1 — skipping Build-ID routing rule"
    return 0
  fi
  local temporal_cmd=("${COMPOSE[@]}" exec -T temporal temporal --address temporal:7233)
  # Register the namespace if it doesn't exist (the auto-setup image only
  # creates the default namespace; custom namespaces must be registered).
  if ! "${temporal_cmd[@]}" operator namespace describe -n "$ns" >/dev/null 2>&1; then
    log "registering temporal namespace '${ns}'…"
    "${temporal_cmd[@]}" operator namespace create "$ns" >/dev/null 2>&1 || true
  fi
  # get-rules returns assignmentRules:null when none exist.
  local current
  current="$("${temporal_cmd[@]}" task-queue versioning get-rules -t "$queue" -n "$ns" -o json 2>/dev/null \
              | jq -r '.assignmentRules[0].targetBuildID // empty' 2>/dev/null)" || true
  if [[ "$current" == "$build_id" ]]; then
    ok "temporal queue '$queue' already routes to build '$build_id'"
    return 0
  fi
  log "promoting temporal build '$build_id' on queue '$queue'…"
  "${temporal_cmd[@]}" task-queue versioning insert-assignment-rule \
    -t "$queue" -n "$ns" --build-id "$build_id" --rule-index 0 --percentage 100 -y >/dev/null 2>&1 \
    || { warn "failed to insert temporal assignment rule — funnel worker may not boot in strict mode"; return 0; }
  ok "temporal queue '$queue' routes to build '$build_id' (100%)"
}

# --- DuckDB native binding ----------------------------------------------------
# The Dockerfile installs prod deps with `--ignore-scripts` (avoids native-
# build fragility) then runs `pnpm rebuild duckdb` to fetch the prebuilt
# .node binary into the image. The funnel's `computeChangelog` activity
# requires duckdb; without the binding it exhausts retries and fails.
# This step verifies the binding loads in the running container and, as a
# fallback for images built before the Dockerfile fix, attempts a live
# `pnpm rebuild duckdb` (needs the container running, not crash-looping).
bootstrap_duckdb_binding() {
  # Quick load test — if duckdb requires successfully, the binding is present
  # (the image was built with the Dockerfile's `pnpm rebuild duckdb` step).
  # Use `compose exec` so it targets THIS project's app container.
  if "${COMPOSE[@]}" exec -T app node -e "require('duckdb')" >/dev/null 2>&1; then
    ok "duckdb native binding present"
    return 0
  fi
  # Fallback: the container may be crash-looping (missing schema) and not
  # exec-able. Stop it, run the rebuild in a throwaway container (writes to
  # the image layer via docker commit), then start it. This path is for
  # images built before the Dockerfile fix shipped the binding.
  log "duckdb binding missing — attempting live install (stop app, rebuild, restart)…"
  "${COMPOSE[@]}" stop app >/dev/null 2>&1 || true
  if "${COMPOSE[@]}" run --rm --no-deps -u root app pnpm rebuild duckdb >/dev/null 2>&1; then
    ok "duckdb native binding installed (throwaway container)"
  else
    warn "duckdb rebuild failed — funnel indexing will fail until the binding is installed (rebuild the image with the Dockerfile fix)"
  fi
}

# Core-mode bootstrap: no containerised `app`, no temporal, no duckdb — the
# backend runs on the host (`pnpm dev`). We do the infra-only parts: PG
# password sync, keycloak realm + superadmin + passkey gate. Migrations:
# if the ledger is missing AND the app image exists, run them via the image
# (same as full mode); otherwise point the user at the host pnpm scripts
# (the host dev backend is what needs the schema anyway).
# Called with the STARTED service list ($@) so it can skip keycloak when a
# foreign container already serves :8086.
post_up_bootstrap_core() {
  log "post-up bootstrap (core: keycloak realm + superadmin + login gate)"
  wait_for_service_healthy postgres 120
  local want=""
  for s in "$@"; do [[ "$s" == "keycloak" ]] && want=1; done
  if [[ -n "$want" ]]; then
    wait_for_service_healthy keycloak 180
  else
    log "keycloak owned by a foreign project — skipping its health gate (realm bootstrap still targets the published host port)"
  fi
  bootstrap_sync_pg_password

  local pguser pgdb marker
  pguser="$(env_val PGUSER)"; pguser="${pguser:-tellus}"
  pgdb="$(env_val PGDATABASE)"; pgdb="${pgdb:-tellus_db}"
  marker="$("${COMPOSE[@]}" exec -T postgres psql -U "$pguser" -d "$pgdb" \
            -tAc "SELECT to_regclass('schema_migrations_applied')" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$marker" == "schema_migrations_applied" ]]; then
    ok "schema ledger present — skipping migrations"
  elif docker image inspect tellus-app >/dev/null 2>&1; then
    bootstrap_run_migrations
  else
    warn "fresh database and no app image (core mode doesn't build it) — run on the host: pnpm migrate && pnpm migrate:foundry && pnpm migrate:auth"
  fi

  bootstrap_keycloak_realm
  bootstrap_ensure_superadmin
  bootstrap_disable_passkey_gate
  ok "core post-up bootstrap complete"
}

# Orchestrate the full post-up bootstrap. Called from main() only when
# DO_BOOTSTRAP=1 and WAIT=1 (the app must reach healthy before the late steps).
post_up_bootstrap() {
  log "post-up bootstrap (migrations + keycloak realm + superadmin + login gate + temporal versioning + duckdb)"
  # --- early: infra must be up before the app can be useful ---
  wait_for_service_healthy postgres 120
  wait_for_service_healthy keycloak 180
  wait_for_service_healthy temporal 180
  # Provision the temporal Build-ID routing rule BEFORE the app boots so the
  # strict-mode worker can register on first try (not crash-loop until the
  # rule exists). Idempotent — no-op if the rule already matches.
  bootstrap_temporal_versioning
  bootstrap_sync_pg_password
  bootstrap_run_migrations
  # The app was started by `up -d` but crash-looped on the missing schema
  # (or a stale password). Restart it so the migration gate now passes.
  log "restarting app to pick up schema…"
  "${COMPOSE[@]}" restart app >/dev/null 2>&1 || true
  wait_for_health
  # Verify/install the duckdb native binding. The image (Dockerfile) ships it
  # via `pnpm rebuild duckdb`; this verifies it loads and falls back to a
  # live rebuild for older images. Needs the app container running (post-restart).
  bootstrap_duckdb_binding

  # --- late: realm + superadmin (need the app running for role grant) ---
  bootstrap_keycloak_realm
  bootstrap_ensure_superadmin
  if [[ "${SUPERADMIN_CREATED:-0}" -eq 1 ]]; then
    log "restarting app so its bootstrap grants the tellus-superadmin role…"
    "${COMPOSE[@]}" restart app >/dev/null 2>&1 || true
    wait_for_service_healthy app 120
  fi
  bootstrap_disable_passkey_gate
  ok "post-up bootstrap complete"
}

# --- core-mode summary -------------------------------------------------------
summary_core() {
  echo
  ok "Tellus dev-core infra is up ($(as_line "${services[@]}"))."
  cat <<'EOF'
   • PostgreSQL         localhost:5432
   • OpenSearch         http://localhost:9200
   • Keycloak           http://localhost:8086
   • MinIO (S3 API/UI)  http://localhost:9000 / http://localhost:9001

  NOT started (backend degrades gracefully): kafka/zk, redis, clickhouse,
  temporal, lakekeeper, the containerised app — run the backend on the host
  with `pnpm dev` and the FE in tellus-fe with `pnpm dev`.
EOF
  echo
  log "status:";  "${COMPOSE[@]}" ps
  echo
  log "full stack:  ./run.sh   (adds kafka, clickhouse, redis, temporal, lakekeeper, app)"
  log "stop stack:  ./stop.sh"
}

# --- endpoint summary --------------------------------------------------------
summary() {
  echo
  ok "Tellus backend is up. Key endpoints (host-published):"
  cat <<'EOF'
   • App / API          http://localhost:3000  (health: /api/v1/health)
   • PostgreSQL         localhost:5432
   • OpenSearch         http://localhost:9200
   • Kafka (host)       localhost:9092
   • Schema Registry    http://localhost:8081
   • Keycloak           http://localhost:8086
   • MinIO (S3 API/UI)  http://localhost:9000 / http://localhost:9001
   • Redis              localhost:6379
   • ClickHouse         http://localhost:8123
   • Temporal           localhost:7233
   • Lakekeeper         http://localhost:8181
EOF
  echo
  log "status:";  "${COMPOSE[@]}" ps
  echo
  log "follow logs:  $(as_line "${COMPOSE[@]}") logs -f app"
  log "stop stack:   ./stop.sh"
}

# --- main --------------------------------------------------------------------
main() {
  preflight

  if [[ "$DO_PULL" -eq 1 ]]; then
    log "pulling newer base images…"; "${COMPOSE[@]}" pull --ignore-buildable || warn "pull had issues; continuing"
  fi

  # Unpause any paused containers before `up`. Docker refuses to start or
  # recreate a paused container ("cannot start a paused container"), which makes
  # the whole `up` fail. Containers get paused by Docker Desktop's resource
  # saver (auto-pause when idle) or by a manual `docker pause`; resume them so
  # the stack can come up cleanly. No-op (and non-fatal) when nothing is paused.
  if [[ -n "$("${COMPOSE[@]}" ps -q --filter status=paused 2>/dev/null)" ]]; then
    log "unpausing paused containers…"
    "${COMPOSE[@]}" unpause -q >/dev/null 2>&1 \
      || docker ps --filter status=paused --format '{{.Names}}' | xargs -r docker unpause >/dev/null 2>&1 \
      || warn "could not unpause all containers — run: docker ps --filter status=paused"
  fi

  local up=(up -d --remove-orphans)
  [[ "$DO_BUILD"  -eq 1 ]] && up+=(--build)
  [[ "$RECREATE"  -eq 1 ]] && up+=(--force-recreate)

  # Resolve the service subset: explicit RUN_SERVICES env wins, then --core,
  # then the full stack (no service list).
  local services=()
  if [[ -n "${RUN_SERVICES:-}" ]]; then
    # shellcheck disable=SC2206
    services=(${RUN_SERVICES})
  elif [[ "$MODE" == "core" ]]; then
    services=("${CORE_SERVICES[@]}")
  fi

  # Foreign-keycloak guard (2026-08-13): port 8086 may already be held by a
  # container from ANOTHER compose project — historically the standalone
  # docker-compose-files/keycloak.docker-compose.yml (`tellus-keycloak`,
  # uncapped, KC_DB=dev-file). Also possible: the capped per-suffix sibling
  # (tellus-verify-keycloak) while the user wants THIS project's Keycloak
  # (kc-proxy). `compose up` on our keycloak in that case aborts with a
  # bind conflict and the ERR trap leaves the rest half-started. Drop our
  # keycloak from the start set; the app still reaches Keycloak on the
  # published host port regardless of which project serves it.
  local kc_held_foreign=""
  if [[ ${#services[@]} -gt 0 ]]; then
    local holder holder_project
    holder="$(docker ps -q --filter publish=8086 2>/dev/null | head -1 || true)"
    if [[ -n "$holder" ]]; then
      holder_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$holder" 2>/dev/null || true)"
      local holder_name; holder_name="$(docker inspect -f '{{.Name}}' "$holder" 2>/dev/null | sed 's#^/##')"
      if [[ "$holder_project" != "$PROJECT_NAME" ]]; then
        kc_held_foreign="$holder_name (${holder_project:-unknown})"
        warn "port 8086 is held by foreign container '$holder_name' (compose project '${holder_project:-unknown}') — skipping THIS project's keycloak service; the app still reaches Keycloak on localhost:8086"
        local kept=() svc_name
        for svc_name in "${services[@]}"; do
          [[ "$svc_name" == "keycloak" ]] || kept+=("$svc_name")
        done
        services=("${kept[@]}")
      fi
    fi
  fi

  if [[ ${#services[@]} -gt 0 ]]; then
    # Diet enforcement (verified empirically): `up <subset>` does NOT stop
    # services outside the subset — `--remove-orphans` only prunes services
    # that were REMOVED FROM THE FILE. Stop the complement explicitly, or
    # kafka/clickhouse/temporal keep burning RAM/CPU despite core mode.
    local stop_list=() defined svc line in_set
    defined="$("${COMPOSE[@]}" config --services 2>/dev/null)"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      in_set=""
      for svc in "${services[@]}"; do [[ "$svc" == "$line" ]] && in_set=1; done
      [[ -z "$in_set" ]] && stop_list+=("$line")
    done <<< "$defined"
    if [[ ${#stop_list[@]} -gt 0 ]]; then
      log "stopping out-of-subset services: $(as_line "${stop_list[@]}")"
      "${COMPOSE[@]}" stop "${stop_list[@]}" >/dev/null 2>&1 || true
    fi

    log "starting ${#services[@]} services (mode=$MODE): $(as_line "${services[@]}")"
    "${COMPOSE[@]}" "${up[@]}" "${services[@]}"
    if [[ "$WAIT" -eq 1 ]]; then
      # Gate on the named services only — the rest of the stack is
      # intentionally down/paused, so the full wait_for_health can never
      # pass. Note: `--remove-orphans` + a service list also DOWNs any
      # running service not in the list (by design — it prunes the stack
      # to exactly this subset).
      for svc in "${services[@]}"; do
        wait_for_service_healthy "$svc" 180
      done
      [[ "$DO_BOOTSTRAP" -eq 1 ]] && post_up_bootstrap_core "${services[@]}"
    else
      warn "--no-wait set: not gating on health (bootstrap skipped)"
    fi
    summary_core
  else
    log "starting stack: $(as_line "${COMPOSE[@]}") $(as_line "${up[@]}")"
    "${COMPOSE[@]}" "${up[@]}"

    if [[ "$WAIT" -eq 1 ]]; then
      if [[ "$DO_BOOTSTRAP" -eq 1 ]]; then
        post_up_bootstrap
      else
        wait_for_health
      fi
    else
      warn "--no-wait set: not gating on health (bootstrap skipped)"
    fi

    summary
  fi

  if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
    if [[ ${#services[@]} -gt 0 ]]; then
      warn "--logs in core/subset mode: no containerised app — follow your host \`pnpm dev\` instead"
    else
      log "tailing app logs (Ctrl-C to detach; stack keeps running)…"
      exec "${COMPOSE[@]}" logs -f app
    fi
  fi
}

main "$@"
