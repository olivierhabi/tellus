#!/usr/bin/env bash
# ============================================================================
# verify-keycloak-admin-password.sh — regression guard for the Keycloak
# master-admin credential finding (vendor-default admin/admin = full IdP
# takeover: token minting for any app user + confidential client-secret
# disclosure).
#
# Asserts:
#   1. The vendor-default credentials admin/admin are REJECTED (401) by the
#      master-realm token endpoint — i.e. the live instance was rotated.
#   2. The configured admin credentials (KC_ADMIN_USER/KC_ADMIN_PASS, else
#      repo-root .env's KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD) are
#      ACCEPTED — i.e. the stack's own tooling still works.
#   3. The compose file contains no hardcoded admin/admin literals.
#
# Exit 0 iff all three hold. Wire into deployment smoke checks.
# ============================================================================
set -euo pipefail

KC="${KC_URL:-http://localhost:8086}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

# --- 1. vendor default must be rejected --------------------------------------
if curl -s -m 8 -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  -d username=admin -d password=admin \
  | grep -q access_token; then
  echo "FAIL: Keycloak master realm still accepts vendor-default admin/admin"
  FAIL=1
else
  echo "PASS: vendor-default admin/admin rejected (401)"
fi

# --- 2. configured credentials must work -------------------------------------
USER="${KC_ADMIN_USER:-$(grep -m1 '^KEYCLOAK_ADMIN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2-)}"
USER="${USER:-admin}"
if [ -z "${KC_ADMIN_PASS:-}" ]; then
  KC_ADMIN_PASS="$(grep -m1 '^KEYCLOAK_ADMIN_PASSWORD=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
fi
if [ -z "${KC_ADMIN_PASS:-}" ]; then
  echo "FAIL: no configured master admin password (KC_ADMIN_PASS or .env KEYCLOAK_ADMIN_PASSWORD)"
  FAIL=1
elif curl -s -m 8 -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  -d "username=$USER" -d "password=$KC_ADMIN_PASS" \
  | grep -q access_token; then
  echo "PASS: configured master admin credentials accepted"
else
  echo "FAIL: configured master admin credentials rejected — stack tooling is broken"
  FAIL=1
fi

# --- 3. no hardcoded literals in compose --------------------------------------
if grep -n "KEYCLOAK_ADMIN_PASSWORD: admin$" "$ROOT/docker-compose.yml" >/dev/null 2>&1; then
  echo "FAIL: docker-compose.yml still pins the vendor-default password"
  FAIL=1
else
  echo "PASS: docker-compose.yml has no hardcoded admin password literal"
fi

exit "$FAIL"
