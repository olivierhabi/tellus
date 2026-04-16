#!/usr/bin/env bash
#
# test-auth-e2e.sh
# ----------------
# One-command end-to-end backend auth test for the Palantir Multipass
# replication described in ontology/tellus-auth.md.
#
# What it does:
#   1. `docker compose up -d keycloak`  (from tellus/docker-compose.yml)
#   2. Waits for /health/ready to report UP on http://localhost:8086
#   3. Runs bootstrap-keycloak.sh to install the `tellus` realm, clients,
#      roles, and cypress test users (idempotent — safe to re-run)
#   4. Runs the non-API verify scripts directly against Keycloak:
#        • verify-auth-realm.sh   (Task 1)
#        • verify-saml-cert-expiry.sh (Task 2)
#        • verify-auth-oauth.sh   (Task 4: PKCE + refresh rotation)
#        • verify-auth-mfa.sh     (Task 5: WebAuthn policy + brute-force)
#   5. If TELLUS_API_URL is reachable, also runs the two scripts that
#      exercise the tellus server (verify-auth-jwt, verify-auth-pat).
#
# Environment:
#   KEEP_RUNNING=1   don't tear down after success (default)
#   TELLUS_API_URL   override the tellus backend URL (default :3000)
#
# Exit 0 only if every phase passes. Exit 1 on first failure.

set -e
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

KC_URL="${KC_URL:-http://localhost:8086}"
REALM="${KC_REALM:-tellus}"
TELLUS_API_URL="${TELLUS_API_URL:-http://localhost:3000}"
KEEP_RUNNING="${KEEP_RUNNING:-1}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.yml}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}~${NC} %s\n" "$1"; }
err()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
step() { printf "\n${BOLD}=== %s ===${NC}\n" "$1"; }

DOCKER=""
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER="docker-compose"
  fi
fi
[[ -z "$DOCKER" ]] && err "docker compose not installed"

# --- 1. Bring up Keycloak ----------------------------------------------------
# Reuse an already-running instance if one is bound to $KC_URL (e.g. the
# developer started it manually earlier). Otherwise drive it via
# `docker compose up -d keycloak` against the project compose file.
step "ensure Keycloak is running"
if curl -sf -o /dev/null "$KC_URL/realms/master/.well-known/openid-configuration"; then
  ok "keycloak already responding on $KC_URL — reusing it"
  KC_WAS_RUNNING=1
else
  (cd "$ROOT" && $DOCKER -f "$COMPOSE_FILE" up -d keycloak) \
    || err "docker compose up failed (is another container bound to 8086? run scripts/test-auth-e2e-down.sh --wipe)"
  ok "keycloak container up"
  KC_WAS_RUNNING=0
fi

# --- 2. Wait for readiness ---------------------------------------------------
step "waiting for Keycloak /health/ready"
DEADLINE=$(( $(date +%s) + 180 ))
while :; do
  if curl -sf "$KC_URL/health/ready" 2>/dev/null | grep -q '"status": "UP"'; then
    ok "keycloak reports UP"
    break
  fi
  # dev-mode Keycloak exposes /health/ready on 9000 inside the container but
  # only HTTP on 8086 is published; fall back to probing the token endpoint
  # which is an unambiguous "server is answering" signal.
  if curl -sf -o /dev/null "$KC_URL/realms/master/.well-known/openid-configuration"; then
    ok "keycloak responding on $KC_URL"
    break
  fi
  if (( $(date +%s) > DEADLINE )); then
    $DOCKER -f "$COMPOSE_FILE" logs --tail=80 keycloak || true
    err "keycloak did not become ready within 180s"
  fi
  sleep 3
done

# Master realm needs a moment to finish initial user import after first boot.
sleep 2

# --- 3. Bootstrap the tellus realm ------------------------------------------
step "bootstrap-keycloak.sh (realm=$REALM)"
KC_URL="$KC_URL" KC_REALM="$REALM" bash "$HERE/bootstrap-keycloak.sh"

# --- 4. Keycloak-only verifications -----------------------------------------
step "verify-auth-realm.sh"
KC_URL="$KC_URL" KC_REALM="$REALM" bash "$HERE/verify-auth-realm.sh"

step "verify-saml-cert-expiry.sh"
KC_URL="$KC_URL" KC_REALM="$REALM" bash "$HERE/verify-saml-cert-expiry.sh"

step "verify-auth-oauth.sh"
KC_URL="$KC_URL" KC_REALM="$REALM" bash "$HERE/verify-auth-oauth.sh"

step "verify-auth-mfa.sh"
KC_URL="$KC_URL" KC_REALM="$REALM" bash "$HERE/verify-auth-mfa.sh"

# --- 5. Backend verifications (only if the tellus API is live) ---------------
step "tellus API probe at $TELLUS_API_URL"
if curl -sf -o /dev/null "$TELLUS_API_URL/api/v1/auth/oidc/config"; then
  ok "tellus backend responding — running API-level checks"

  # Ensure the auth schema is present. Harmless if already migrated.
  (cd "$ROOT" && npm run --silent migrate:auth 2>&1 | tail -5 || warn "migrate:auth failed — verify-auth-pat may break")


  step "verify-auth-jwt.sh"
  TELLUS_API_URL="$TELLUS_API_URL" KC_URL="$KC_URL" KC_REALM="$REALM" \
    bash "$HERE/verify-auth-jwt.sh"

  step "verify-auth-pat.sh"
  TELLUS_API_URL="$TELLUS_API_URL" KC_URL="$KC_URL" KC_REALM="$REALM" \
    bash "$HERE/verify-auth-pat.sh"

  step "verify-auth-keycloak-only.sh (identity parity + legacy retirement)"
  TELLUS_API_URL="$TELLUS_API_URL" KC_URL="$KC_URL" KC_REALM="$REALM" \
    bash "$HERE/verify-auth-keycloak-only.sh"
else
  warn "tellus backend not reachable at $TELLUS_API_URL — skipping API verifications"
  warn "  start it with: (cd $ROOT && npm run dev) and re-run this script"
fi

# --- 6. SSO redirect smoke test ---------------------------------------------
# Mirrors the exact URL the frontend generates when the user clicks
# "Sign in with Keycloak SSO". Asserts Keycloak returns 200 (the login
# page HTML) rather than 400 ("Invalid parameter: redirect_uri") or 404
# ("Realm does not exist").
step "SSO redirect smoke test"
REDIR="http://localhost:3000/api/v1/auth/oidc/callback"
ENCODED_REDIR=$(printf '%s' "$REDIR" | jq -sRr @uri)
AUTH_URL="$KC_URL/realms/$REALM/protocol/openid-connect/auth?response_type=code&client_id=tellus-frontend&redirect_uri=$ENCODED_REDIR&state=test&scope=openid&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
HTTP=$(curl -s -o /tmp/auth_page.html -w '%{http_code}' "$AUTH_URL")
if [[ "$HTTP" != "200" ]]; then
  head -c 500 /tmp/auth_page.html >&2 || true
  err "Keycloak auth endpoint returned $HTTP — bootstrap did not register the redirect_uri correctly"
fi
if ! grep -q 'kc-form-login' /tmp/auth_page.html; then
  err "Keycloak auth endpoint returned 200 but did not render a login form (got error page)"
fi
ok "SSO redirect serves the Keycloak login page (client + redirect_uri accepted)"

# --- 7. Teardown -------------------------------------------------------------
if [[ "$KEEP_RUNNING" == "1" ]]; then
  printf "\n${GREEN}✓${NC} all auth e2e checks passed — keycloak left running at $KC_URL\n"
  printf "   (export KEEP_RUNNING=0 to auto-teardown next time)\n"
else
  step "docker compose stop keycloak"
  (cd "$ROOT" && $DOCKER -f "$COMPOSE_FILE" stop keycloak)
  ok "keycloak stopped"
fi
