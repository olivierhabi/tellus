#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-infra.sh — infrastructure verification & chaos harness
#
# Senior-infra-engineer verification: do NOT trust `docker compose ps` health
# flags. Prove each service works with a real data round-trip, validate the
# two recent bug fixes, assert the production-grade properties we configured,
# and (with --chaos) actually break things to confirm persistence and graceful
# degradation. Honest by design: anything we cannot prove is reported as a
# FINDING, not silently skipped.
#
# Usage:
#   scripts/verify-infra.sh            # non-destructive checks only
#   scripts/verify-infra.sh --chaos    # also restart Redis / stop ClickHouse
#   scripts/verify-infra.sh --quiet    # only print failures + summary
#
# Exit code: 0 if no FAILs, 1 otherwise. WARN/FINDING never fail the run.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CHAOS=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --chaos) CHAOS=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- colours (disabled when not a TTY) -------------------------------------
if [[ -t 1 ]]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[34m'; DIM=$'\e[2m'; N=$'\e[0m'
else
  R=""; G=""; Y=""; B=""; DIM=""; N=""
fi

PASS=0; FAIL=0; WARN=0
declare -a FAILURES=()

section() { (( QUIET )) || printf "\n${B}== %s ==${N}\n" "$1"; }
pass()    { PASS=$((PASS+1)); (( QUIET )) || printf "  ${G}PASS${N} %s\n" "$1"; }
fail()    { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf "  ${R}FAIL${N} %s\n" "$1"; }
warn()    { WARN=$((WARN+1)); (( QUIET )) || printf "  ${Y}WARN${N} %s\n" "$1"; }
finding() { printf "  ${Y}FINDING${N} %s\n" "$1"; }
note()    { (( QUIET )) || printf "  ${DIM}· %s${N}\n" "$1"; }

# check "<label>" <cmd...>  → PASS if cmd exits 0, else FAIL
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi; }
# check_eq "<label>" "<expected>" <cmd...>  → PASS if stdout trimmed == expected
check_eq() {
  local label="$1" expected="$2"; shift 2
  local got; got="$("$@" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$got" == "$expected" ]]; then pass "$label"; else fail "$label (got '${got:-<empty>}', want '$expected')"; fi
}

cid() { docker compose ps -q "$1" 2>/dev/null; }

# --- load secrets from .env ------------------------------------------------
PGPASSWORD="$(sed -n 's/^PGPASSWORD=//p' .env 2>/dev/null)"; PGPASSWORD="${PGPASSWORD:-changeme}"
REDIS_PASS="$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' .env 2>/dev/null)"; REDIS_PASS="${REDIS_PASS:-tellus_overlay_pw}"
CH_USER="$(sed -n 's/^CLICKHOUSE_USER=//p' .env 2>/dev/null)"; CH_USER="${CH_USER:-tellus}"
CH_PASS="$(sed -n 's/^CLICKHOUSE_PASSWORD=//p' .env 2>/dev/null)"; CH_PASS="${CH_PASS:-tellus_ch_pw}"

psql_t()  { docker compose exec -T postgres psql -U tellus "$@"; }       # -d set by caller
ch_q()    { curl -s "http://localhost:8123/?user=${CH_USER}&password=${CH_PASS}" --data-binary "$1"; }

printf "${B}infra verification${N}  repo=%s  chaos=%s\n" "$REPO_ROOT" "$([[ $CHAOS == 1 ]] && echo on || echo off)"

# ===========================================================================
section "0. Container inventory"
EXPECTED_UP=(autoheal postgres pg-backup opensearch kafka keycloak minio redis clickhouse \
             temporal temporal-postgres lakekeeper lakekeeper-postgres)
for svc in "${EXPECTED_UP[@]}"; do
  c="$(cid "$svc")"
  if [[ -z "$c" ]]; then fail "$svc container exists"; continue; fi
  state="$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)"
  health="$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)"
  if [[ "$state" == "running" ]]; then
    case "$health" in
      healthy|none) pass "$svc running ($health)" ;;
      starting)     warn "$svc running (health still converging)" ;;   # transient, not a failure
      *)            fail "$svc running but $health" ;;
    esac
  else fail "$svc not running ($state)"; fi
done

# ===========================================================================
section "1. Functional round-trips (prove it WORKS, not just answers)"

# --- Postgres
check_eq "postgres SELECT 1" "1" bash -c 'docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT 1"'
check    "postgres core tables present" bash -c \
  'docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT count(*) FROM ontology" '

# --- Redis SET/GET/DEL round-trip
RK="__verify_$$"
if docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" set "$RK" ok >/dev/null 2>&1; then
  got="$(docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" get "$RK" 2>/dev/null | tr -d '[:space:]')"
  [[ "$got" == "ok" ]] && pass "redis SET/GET round-trip" || fail "redis GET mismatch (got '$got')"
  docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" del "$RK" >/dev/null 2>&1
else fail "redis SET (auth/connect)"; fi

# --- ClickHouse DDL+DML round-trip as the app's user
CHT="verify_lt_$$"
if ch_q "CREATE TABLE IF NOT EXISTS ${CHT} (a UInt32) ENGINE=MergeTree ORDER BY a" >/dev/null 2>&1 \
   && ch_q "INSERT INTO ${CHT} VALUES (7)" >/dev/null 2>&1; then
  got="$(ch_q "SELECT a FROM ${CHT} WHERE a=7 FORMAT TabSeparated" | tr -d '[:space:]')"
  [[ "$got" == "7" ]] && pass "clickhouse CREATE/INSERT/SELECT round-trip" || fail "clickhouse SELECT mismatch (got '$got')"
  ch_q "DROP TABLE IF EXISTS ${CHT}" >/dev/null 2>&1
else fail "clickhouse DDL/DML (auth as ${CH_USER})"; fi

# --- Temporal: frontend serving + the namespace the worker needs
check_eq "temporal frontend SERVING" "SERVING" bash -c \
  'docker compose exec -T temporal temporal operator cluster health --address temporal:7233 2>/dev/null | tr -d "[:space:]"'
check_eq "temporal namespace tellus-funnel" "tellus-funnel" bash -c \
  'docker compose exec -T postgres psql -U tellus -d temporal -tAc "SELECT name FROM namespaces WHERE name='"'"'tellus-funnel'"'"'"'

# --- Lakekeeper: bootstrapped + management API live + warehouse round-trip
check_eq "lakekeeper bootstrapped" "true" bash -c \
  'curl -s http://localhost:8181/management/v1/info | sed -n "s/.*\"bootstrapped\":\([a-z]*\).*/\1/p"'
check "lakekeeper warehouse list API" bash -c \
  'curl -sf http://localhost:8181/management/v1/warehouse >/dev/null'

# ===========================================================================
section "2. Bug-fix validation"

# Fix #1: connectivity_credentials.rotate_after_days column + worker query parses
check "migration 087 recorded in ledger" bash -c \
  'docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT 1 FROM schema_migrations_applied WHERE migration_name='"'"'087_b2_credential_rotation_policy.sql'"'"'" | grep -q 1'
check_eq "rotate_after_days column exists" "rotate_after_days" bash -c \
  'docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='"'"'connectivity_credentials'"'"' AND column_name='"'"'rotate_after_days'"'"'"'
# Run the worker's EXACT query — proves issued_at→created_at / revoked_at→superseded_at fix.
check "rotation worker query executes (no 42703)" bash -c \
  'docker compose exec -T postgres psql -U tellus -d tellus_db -tAc "SELECT connection_rid, tenant, field, version, rotate_after_days FROM connectivity_credentials WHERE superseded_at IS NULL AND rotate_after_days IS NOT NULL AND created_at < now() - (rotate_after_days * INTERVAL '"'"'1 day'"'"') + (1 * INTERVAL '"'"'1 day'"'"') ORDER BY created_at ASC LIMIT 50"'
# Guard against regression: the dropped column names must NOT exist.
for badcol in issued_at revoked_at; do
  if docker compose exec -T postgres psql -U tellus -d tellus_db -tAc \
      "SELECT 1 FROM information_schema.columns WHERE table_name='connectivity_credentials' AND column_name='$badcol'" 2>/dev/null | grep -q 1; then
    fail "stale column '$badcol' unexpectedly present"
  else pass "no stale '$badcol' column (worker uses real schema)"; fi
done

# Fix #2: overlay store — Redis reachable with auth (the spam was Redis-down).
check "overlay backend (redis) reachable+auth" bash -c \
  'docker compose exec -T redis redis-cli --no-auth-warning -a '"$REDIS_PASS"' ping | grep -q PONG'

# ===========================================================================
section "3. Production-grade properties we configured"

for svc in redis clickhouse temporal lakekeeper; do
  c="$(cid "$svc")"; [[ -z "$c" ]] && { fail "$svc inspect"; continue; }
  mem="$(docker inspect "$c" --format '{{.HostConfig.Memory}}')"
  [[ "${mem:-0}" -gt 0 ]] && pass "$svc memory limit set (${mem}B)" || fail "$svc has NO memory limit"
  logmax="$(docker inspect "$c" --format '{{index .HostConfig.LogConfig.Config "max-size"}}')"
  [[ -n "$logmax" ]] && pass "$svc log rotation ($logmax)" || warn "$svc no log-size cap"
  rp="$(docker inspect "$c" --format '{{.HostConfig.RestartPolicy.Name}}')"
  [[ "$rp" == "unless-stopped" || "$rp" == "always" ]] && pass "$svc restart policy ($rp)" || warn "$svc restart policy '$rp'"
done

# Redis durability config
check_eq "redis AOF persistence on" "appendonlyyes" bash -c \
  'docker compose exec -T redis redis-cli --no-auth-warning -a '"$REDIS_PASS"' config get appendonly | tr -d "[:space:]"'
check_eq "redis bounded-memory eviction" "maxmemory-policyallkeys-lru" bash -c \
  'docker compose exec -T redis redis-cli --no-auth-warning -a '"$REDIS_PASS"' config get maxmemory-policy | tr -d "[:space:]"'

# Lakekeeper image pinning — honest finding (latest = moving target).
LK_IMG="$(docker inspect "$(cid lakekeeper)" --format '{{.Config.Image}}' 2>/dev/null)"
if [[ "$LK_IMG" == *":latest"* || "$LK_IMG" == *":latest-main"* ]]; then
  finding "lakekeeper pinned to '$LK_IMG' — NOT reproducible; pin to a version/digest for prod"
else pass "lakekeeper image pinned ($LK_IMG)"; fi

# ===========================================================================
section "4. Self-healing, DB isolation & backups"

# 4a. autoheal turns healthchecks into recovery (restarts unhealthy-but-alive).
ah="$(cid autoheal)"
if [[ -n "$ah" ]] && [[ "$(docker inspect "$ah" --format '{{.State.Status}}')" == "running" ]]; then
  lbl="$(docker inspect "$ah" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AUTOHEAL_CONTAINER_LABEL=//p')"
  [[ "$lbl" == "all" ]] && pass "autoheal running (watching ALL healthchecked containers)" \
                        || warn "autoheal running but label scope='$lbl' (not 'all')"
else
  finding "no autoheal: Compose restart policy reacts to EXIT, not 'unhealthy'. A hung-but-alive service stays hung."
fi

# 4b. DB isolation: temporal + lakekeeper must NOT be on the app Postgres.
tseed="$(docker inspect "$(cid temporal)" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^POSTGRES_SEEDS=//p')"
[[ "$tseed" == "temporal-postgres" ]] && pass "temporal isolated on its own Postgres ($tseed)" \
                                      || fail "temporal on '$tseed' (expected temporal-postgres)"
if docker inspect "$(cid lakekeeper)" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '@lakekeeper-postgres:5432'; then
  pass "lakekeeper isolated on its own Postgres (lakekeeper-postgres)"
else fail "lakekeeper not pointed at lakekeeper-postgres"; fi

# 4c. Backups: sidecar running + a recent dump actually exists on disk.
check "pg-backup sidecar running" bash -c '[[ -n "$(docker compose ps -q pg-backup)" ]]'
latest_bk="$(find backups/app -name "tellus_db-*.sql.gz" -type f 2>/dev/null | head -1)"
if [[ -n "$latest_bk" ]]; then
  sz="$(wc -c < "$latest_bk" 2>/dev/null)"
  [[ "${sz:-0}" -gt 1000 ]] && pass "app DB backup present ($(du -h "$latest_bk" | cut -f1): $(basename "$latest_bk"))" \
                            || fail "backup file suspiciously small (${sz}B)"
else fail "no app DB backup dump found under backups/app"; fi

# 4d. Remaining honest limitations (these are NOT yet solved).
finding "single Docker host = SPOF; one reboot/disk-full = 100% outage. Compose cannot deliver 99.9%."
finding "backups are logical + on the SAME disk; no WAL/PITR and no off-host copy. Disk loss = data loss."

# ===========================================================================
if (( CHAOS )); then
  section "5. CHAOS — persistence & graceful degradation (destructive, auto-restored)"

  # 5a. AOF persistence: key must survive a Redis container restart.
  PK="__persist_$$"
  docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" set "$PK" survive >/dev/null 2>&1
  docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" bgrewriteaof >/dev/null 2>&1
  sleep 1
  note "restarting redis…"
  docker compose restart redis >/dev/null 2>&1
  # wait for redis to accept connections again
  for i in $(seq 1 20); do docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" ping >/dev/null 2>&1 && break; sleep 1; done
  got="$(docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" get "$PK" 2>/dev/null | tr -d '[:space:]')"
  [[ "$got" == "survive" ]] && pass "redis key survived restart (AOF durable)" || fail "redis key LOST across restart (got '$got') — durability broken"
  docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" del "$PK" >/dev/null 2>&1

  # 5a2. Autoheal recovery: drive Redis 'unhealthy' WITHOUT killing the process —
  # the hung-but-alive case Docker's restart policy ignores. (Note: SIGSTOP to
  # PID 1 from inside the container is silently ignored by the kernel — the
  # PID-namespace init is signal-protected — so we instead rotate requirepass
  # at runtime, which makes the healthcheck's auth fail while redis keeps
  # running. A restart reloads the original --requirepass, so recovery is
  # self-proving.) autoheal must detect unhealthy and restart it.
  rc_id="$(cid redis)"
  before_start="$(docker inspect "$rc_id" --format '{{.State.StartedAt}}' 2>/dev/null)"
  note "breaking redis healthcheck (runtime requirepass change) to force 'unhealthy'…"
  docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" config set requirepass "__wrong_$$" >/dev/null 2>&1
  healed=0
  for i in $(seq 1 24); do   # up to ~120s: ~30s to go unhealthy + autoheal interval
    sleep 5
    now_start="$(docker inspect "$(cid redis)" --format '{{.State.StartedAt}}' 2>/dev/null)"
    if [[ -n "$now_start" && "$now_start" != "$before_start" ]]; then healed=1; break; fi
  done
  if (( healed )); then
    for i in $(seq 1 15); do docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" ping 2>/dev/null | grep -q PONG && break; sleep 1; done
    if docker compose exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASS" ping 2>/dev/null | grep -q PONG; then
      pass "autoheal restarted unhealthy redis (hung-but-alive recovery works)"
    else fail "redis restarted but original password not restored"; fi
  else
    fail "autoheal did NOT restart unhealthy redis within ~120s"
    docker restart "$rc_id" >/dev/null 2>&1   # clean up: restart reloads original requirepass
  fi

  # 5b. Graceful degradation: stop ClickHouse, app /health must still be OK.
  APP_UP=0
  curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1 && APP_UP=1
  if (( APP_UP )); then
    note "stopping clickhouse to test degradation…"
    docker compose stop clickhouse >/dev/null 2>&1
    sleep 3
    if curl -sf http://localhost:3000/api/v1/health >/dev/null 2>&1; then
      pass "app stayed healthy with ClickHouse down (graceful degradation)"
    else
      fail "app /health FAILED with ClickHouse down — best-effort dep is actually hard-gating"
    fi
    note "restarting clickhouse…"
    docker compose start clickhouse >/dev/null 2>&1
  else
    warn "app not reachable on localhost:3000 — skipped degradation test (start the host server to run it)"
  fi
else
  note "skipping chaos tests (pass --chaos to run persistence + degradation)"
fi

# ===========================================================================
printf "\n${B}== SUMMARY ==${N}\n"
printf "  ${G}PASS=%d${N}  ${R}FAIL=%d${N}  ${Y}WARN=%d${N}\n" "$PASS" "$FAIL" "$WARN"
if (( FAIL > 0 )); then
  printf "\n${R}Failures:${N}\n"; for f in "${FAILURES[@]}"; do printf "  - %s\n" "$f"; done
  exit 1
fi
printf "${G}All functional checks passed.${N} Review FINDINGs above — they are real uptime limits, not test noise.\n"
exit 0
