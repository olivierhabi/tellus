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
#   ./run.sh --no-build      # start without rebuilding the app image
#   ./run.sh --pull          # pull newer base images before building
#   ./run.sh --recreate      # force-recreate containers
#   ./run.sh --no-wait       # start in background, don't block on health
#   ./run.sh --logs          # tail app logs after it becomes healthy
#   ./run.sh -h | --help
#
# Overridable via env: COMPOSE_FILE, PROJECT_NAME, ENV_FILE, HEALTH_TIMEOUT.
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

# --- pretty logging (auto-disabled when not a TTY or NO_COLOR set) ------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RST=$'\033[0m'; C_INF=$'\033[36m'; C_OK=$'\033[32m'; C_WRN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RST=""; C_INF=""; C_OK=""; C_WRN=""; C_ERR=""
fi
# Join an array into a single space-separated line for display (IFS is \n\t,
# so "${arr[*]}" would otherwise show one element per line).
as_line() { local IFS=' '; echo "$*"; }
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
    --no-build)  DO_BUILD=0 ;;
    --pull)      DO_PULL=1 ;;
    --recreate)  RECREATE=1 ;;
    --no-wait)   WAIT=0 ;;
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

  log "starting stack: $(as_line "${COMPOSE[@]}") $(as_line "${up[@]}")"
  "${COMPOSE[@]}" "${up[@]}"

  if [[ "$WAIT" -eq 1 ]]; then
    wait_for_health
  else
    warn "--no-wait set: not gating on health"
  fi

  summary

  if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
    log "tailing app logs (Ctrl-C to detach; stack keeps running)…"
    exec "${COMPOSE[@]}" logs -f app
  fi
}

main "$@"
