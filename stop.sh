#!/usr/bin/env bash
# =============================================================================
# stop.sh — gracefully stop the Tellus backend and all of its services.
#
# Mirrors run.sh: same project name and compose file, so it tears down exactly
# the stack run.sh brought up. Safe by default — it NEVER deletes your data
# volumes unless you explicitly ask with --volumes (and confirm).
#
# Usage:
#   ./stop.sh                  # graceful `compose down` (keeps named volumes)
#   ./stop.sh --timeout 60     # allow 60s for graceful container shutdown
#   ./stop.sh --keep           # just `stop` containers (don't remove them)
#   ./stop.sh --volumes        # ALSO remove named volumes (DESTROYS DATA) — prompts
#   ./stop.sh --volumes --yes  # …skip the confirmation prompt (for CI)
#   ./stop.sh --images local   # also remove images built by this compose
#   ./stop.sh -h | --help
#
# Overridable via env: COMPOSE_FILE, PROJECT_NAME, ENV_FILE, STOP_TIMEOUT.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
cd -- "$SCRIPT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PROJECT_NAME="${PROJECT_NAME:-tellus}"
ENV_FILE="${ENV_FILE:-.env}"
STOP_TIMEOUT="${STOP_TIMEOUT:-30}"   # graceful shutdown grace period (seconds)

REMOVE_VOLUMES=0; KEEP_CONTAINERS=0; ASSUME_YES=0; REMOVE_IMAGES=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RST=$'\033[0m'; C_INF=$'\033[36m'; C_OK=$'\033[32m'; C_WRN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RST=""; C_INF=""; C_OK=""; C_WRN=""; C_ERR=""
fi
# Join an array into a single space-separated line for display (IFS is \n\t).
as_line() { local IFS=' '; echo "$*"; }
ts()   { date +'%H:%M:%S'; }
log()  { printf '%s %s[stop]%s %s\n' "$(ts)" "$C_INF" "$C_RST" "$*"; }
ok()   { printf '%s %s[ ok ]%s %s\n' "$(ts)" "$C_OK"  "$C_RST" "$*"; }
warn() { printf '%s %s[warn]%s %s\n' "$(ts)" "$C_WRN" "$C_RST" "$*" >&2; }
die()  { printf '%s %s[err ]%s %s\n' "$(ts)" "$C_ERR" "$C_RST" "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO (exit $?)"' ERR

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --volumes|-v)  REMOVE_VOLUMES=1 ;;
    --keep)        KEEP_CONTAINERS=1 ;;
    --yes|-y)      ASSUME_YES=1 ;;
    --timeout)     shift; [[ "${1:-}" =~ ^[0-9]+$ ]] || die "--timeout needs a number"; STOP_TIMEOUT="$1" ;;
    --images)      shift; case "${1:-}" in local|all) REMOVE_IMAGES="$1" ;; *) die "--images takes 'local' or 'all'";; esac ;;
    -h|--help)     usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

COMPOSE=(docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin not found"
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable — is Docker running?"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

running="$("${COMPOSE[@]}" ps -q 2>/dev/null | wc -l | tr -d ' ')"
log "project '$PROJECT_NAME' currently has $running container(s)"

# --- --keep: stop processes but leave containers in place --------------------
if [[ "$KEEP_CONTAINERS" -eq 1 ]]; then
  log "stopping containers (kept for fast restart) with ${STOP_TIMEOUT}s grace…"
  "${COMPOSE[@]}" stop -t "$STOP_TIMEOUT"
  ok "containers stopped (data + containers preserved). Restart with ./run.sh"
  exit 0
fi

# --- guard destructive volume removal ----------------------------------------
DOWN=(down --remove-orphans -t "$STOP_TIMEOUT")
if [[ "$REMOVE_VOLUMES" -eq 1 ]]; then
  warn "--volumes will PERMANENTLY DELETE named volumes for project '$PROJECT_NAME':"
  "${COMPOSE[@]}" config --volumes 2>/dev/null | sed 's/^/        - /' || true
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    printf '%s %s[warn]%s Type the project name (%s) to confirm data deletion: ' "$(ts)" "$C_WRN" "$C_RST" "$PROJECT_NAME"
    read -r reply
    [[ "$reply" == "$PROJECT_NAME" ]] || die "confirmation mismatch — aborting, no data deleted"
  fi
  DOWN+=(--volumes)
fi
[[ -n "$REMOVE_IMAGES" ]] && DOWN+=(--rmi "$REMOVE_IMAGES")

# --- tear down ---------------------------------------------------------------
log "tearing down: $(as_line "${COMPOSE[@]}") $(as_line "${DOWN[@]}")"
"${COMPOSE[@]}" "${DOWN[@]}"

# --- report leftovers (should be none) ---------------------------------------
left="$("${COMPOSE[@]}" ps -q 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$left" == "0" ]]; then
  if [[ "$REMOVE_VOLUMES" -eq 1 ]]; then
    ok "stack stopped and volumes removed (data deleted)."
  else
    ok "stack stopped. Named volumes (your data) preserved — ./run.sh restores it."
  fi
else
  warn "$left container(s) still present — inspect with: $(as_line "${COMPOSE[@]}") ps -a"
fi
