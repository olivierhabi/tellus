#!/usr/bin/env bash
#
# test-auth-e2e-down.sh
# ---------------------
# Tear down the Keycloak container started by test-auth-e2e.sh. Does NOT
# remove the volume so a re-run preserves bootstrapped state — pass
# `--wipe` to also `down -v`.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.yml}"

DOCKER=""
if docker compose version >/dev/null 2>&1; then DOCKER="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DOCKER="docker-compose"
else echo "docker compose not installed" >&2; exit 1; fi

if [[ "${1:-}" == "--wipe" ]]; then
  (cd "$ROOT" && $DOCKER -f "$COMPOSE_FILE" rm -sfv keycloak)
  (cd "$ROOT" && $DOCKER -f "$COMPOSE_FILE" down -v --remove-orphans --no-color 2>/dev/null || true)
  echo "wiped keycloak state"
else
  (cd "$ROOT" && $DOCKER -f "$COMPOSE_FILE" stop keycloak)
  echo "keycloak stopped (state preserved in kcdata volume)"
fi
