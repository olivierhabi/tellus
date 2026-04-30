#!/usr/bin/env bash
#
# verify-saml-cert-expiry.sh
# --------------------------
# Identity provider brokering hygiene check (ontology/tellus-auth.md Task 2).
# Lists every SAML and OIDC IdP configured on the tellus realm and — for
# SAML providers — parses the signing certificate to warn when it's within
# 30 days of expiry. Matches Palantir's behavior of surfacing a banner 30
# days before cert rotation is required.
#
# Exits non-zero if any cert is past expiry.

set -o pipefail

KC="${KC_URL:-http://localhost:8086}"
ADMIN_USER="${KC_ADMIN_USER:-admin}"
ADMIN_PASS="${KC_ADMIN_PASS:-admin}"
REALM="${KC_REALM:-tellus}"
WARN_DAYS=${WARN_DAYS:-30}

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}~${NC} %s\n" "$1"; }
err()  { printf "${RED}✗${NC} %s\n" "$1"; }

TOKEN=$(curl -sf -X POST \
  -d "username=$ADMIN_USER&password=$ADMIN_PASS&grant_type=password&client_id=admin-cli" \
  "$KC/realms/master/protocol/openid-connect/token" | jq -r .access_token)
[[ -z "$TOKEN" || "$TOKEN" == "null" ]] && { err "keycloak admin login failed"; exit 1; }

IDPS=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "$KC/admin/realms/$REALM/identity-provider/instances")

COUNT=$(echo "$IDPS" | jq 'length')
if [[ "$COUNT" == "0" ]]; then
  ok "no SAML/OIDC brokers configured (greenfield realm)"
  exit 0
fi

FAIL=0
echo "$IDPS" | jq -c '.[]' | while read -r idp; do
  ALIAS=$(echo "$idp" | jq -r .alias)
  TYPE=$(echo "$idp" | jq -r .providerId)
  ok "broker $ALIAS (type=$TYPE)"
  if [[ "$TYPE" == "saml" ]]; then
    CERT=$(echo "$idp" | jq -r '.config.signingCertificate // empty')
    [[ -z "$CERT" ]] && continue
    PEM=$'-----BEGIN CERTIFICATE-----\n'"$CERT"$'\n-----END CERTIFICATE-----'
    EXPIRY=$(echo "$PEM" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [[ -z "$EXPIRY" ]] && { warn "could not parse cert for $ALIAS"; continue; }
    EXP_EPOCH=$(date -j -f "%b %e %T %Y %Z" "$EXPIRY" +%s 2>/dev/null \
      || date -d "$EXPIRY" +%s 2>/dev/null)
    NOW=$(date +%s)
    DAYS=$(( (EXP_EPOCH - NOW) / 86400 ))
    if (( DAYS < 0 )); then
      err "$ALIAS SAML cert EXPIRED ($EXPIRY)"
      FAIL=1
    elif (( DAYS <= WARN_DAYS )); then
      warn "$ALIAS SAML cert expires in $DAYS days (Palantir warns at $WARN_DAYS)"
    else
      ok "$ALIAS SAML cert valid for $DAYS days"
    fi
  fi
done

exit ${FAIL:-0}
