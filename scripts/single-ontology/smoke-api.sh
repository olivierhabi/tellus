#!/usr/bin/env bash
# ===========================================================================
# smoke-api.sh — authenticated API smoke test for "One Enterprise, One Ontology"
# ===========================================================================
# Proves, against the running backend, that:
#   * GET  /api/v1/ontology            returns exactly ONE ontology (canonical)
#   * GET  /api/v1/ontology/<anything> collapses to the canonical ontology
#   * GET  /api/v1/ontology/default    (alias) resolves to the canonical ontology
#   * POST /api/v1/ontology            is frozen → 409 ONTOLOGY_SINGLETON
#   * POST /api/v1/ontology/import     is frozen → 409 ONTOLOGY_SINGLETON
#   * DELETE /api/v1/ontology/<canon>  is frozen → 409 ONTOLOGY_SINGLETON
#
# Auth: set TELLUS_TOKEN to a bearer token (copy from your browser session), or
# provide KC_USER / KC_PASS / KC_CLIENT for a Keycloak password grant. If no
# token can be obtained the script SKIPS (exit 0) with instructions rather than
# failing — the DB-level tests already cover the invariants without auth.
# ===========================================================================
set -euo pipefail

BASE="${TELLUS_API_BASE:-http://localhost:3000}"
CANON="00000000-0000-0000-0000-000000000001"
KC_BASE="${KC_BASE:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-app}"

TOKEN="${TELLUS_TOKEN:-}"
if [[ -z "$TOKEN" && -n "${KC_USER:-}" && -n "${KC_PASS:-}" ]]; then
  TOKEN=$(curl -s -m 8 -X POST \
    "$KC_BASE/realms/$KC_REALM/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d grant_type=password -d "client_id=$KC_CLIENT" -d scope=openid \
    --data-urlencode "username=$KC_USER" --data-urlencode "password=$KC_PASS" \
    | grep -oE '"access_token":"[^"]+"' | sed -E 's/.*:"([^"]+)"/\1/')
fi

if [[ -z "$TOKEN" ]]; then
  cat <<'EOF'
⏭  SKIP: no API token available.
   Run an authenticated smoke test with either:
     TELLUS_TOKEN=<bearer> bash scripts/single-ontology/smoke-api.sh
   or:
     KC_USER=<user> KC_PASS=<pass> bash scripts/single-ontology/smoke-api.sh
   (DB-level invariants are already verified by verify-invariants.sh.)
EOF
  exit 0
fi

AUTH=(-H "Authorization: Bearer $TOKEN")
code(){ curl -s -m 10 -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$@"; }
body(){ curl -s -m 10 "${AUTH[@]}" "$@"; }

pass=0; fail=0
chk(){ if [[ "$2" == "$3" ]]; then printf '  \033[32mPASS\033[0m  %-48s (%s)\n' "$1" "$2"; pass=$((pass+1));
       else printf '  \033[31mFAIL\033[0m  %-48s got=%s want=%s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

echo "── API smoke test against $BASE ──"

LIST=$(body "$BASE/api/v1/ontology")
chk "GET /ontology returns one ontology" \
  "$(echo "$LIST" | grep -oE '"ontologyId":"[^"]+"' | sort -u | wc -l | tr -d ' ')" "1"
chk "the one ontology is canonical" \
  "$(echo "$LIST" | grep -oE "$CANON" | head -1)" "$CANON"

chk "GET /ontology/<random-uuid> collapses to canon" \
  "$(body "$BASE/api/v1/ontology/11111111-2222-3333-4444-555555555555" | grep -oE "$CANON" | head -1)" "$CANON"
chk "GET /ontology/default resolves to canon" \
  "$(body "$BASE/api/v1/ontology/default" | grep -oE "$CANON" | head -1)" "$CANON"

chk "POST /ontology is frozen (409)" \
  "$(code -X POST -H 'Content-Type: application/json' -d '{"displayName":"Nope"}' "$BASE/api/v1/ontology")" "409"
chk "POST /ontology/import is frozen (409)" \
  "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/v1/ontology/import")" "409"
chk "DELETE /ontology/<canon> is frozen (409)" \
  "$(code -X DELETE "$BASE/api/v1/ontology/$CANON")" "409"

echo "── $pass passed, $fail failed ──"
[[ "$fail" -eq 0 ]]
