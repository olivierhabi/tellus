#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-import-detail.sh
#
# Regression check for the sync "build details" backend endpoints that power
# the test29 detail page. Specifically guards the 500 we just fixed:
#   GET /imports/:importRid → "r.created_at.toISOString is not a function".
#
# Checks:
#   1. GET /imports/:rid returns 200 (not 500) with a valid ISO createdAt.
#   2. GET /imports/:rid/builds returns 200.
#   3. A freshly created import is readable end-to-end (create → GET).
#   4. (optional) A specific rid passed as $1 is readable.
#
# Usage: scripts/verify-import-detail.sh [IMPORT_RID]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE="${API_BASE:-http://localhost:3000/api/v1/connectivity}"
KC_BASE="${KC_BASE:-http://localhost:8086}"
KC_REALM="${KC_REALM:-tellus}"
KC_CLIENT="${KC_CLIENT:-tellus-frontend}"
SOURCE_RID="${SOURCE_RID:-ri.magritte.main.source.20e01559-7c88-43c4-b574-a083348f7b79}"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
FAILURES=0

EMAIL="$(grep -E '^TELLUS_SUPERADMIN_EMAIL=' "$ROOT/.env" | cut -d= -f2-)"
PASS_PW="$(grep -E '^TELLUS_SUPERADMIN_PASSWORD=' "$ROOT/.env" | cut -d= -f2-)"
TOKEN="$(curl -sf -X POST "$KC_BASE/realms/$KC_REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=password' --data-urlencode "client_id=$KC_CLIENT" \
  --data-urlencode "username=$EMAIL" --data-urlencode "password=$PASS_PW" \
  --data-urlencode 'scope=openid' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
[ -n "$TOKEN" ] || { echo "could not obtain token"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")
JSON=(-H 'Content-Type: application/json')
uu() { python3 -c 'import uuid;print(uuid.uuid4())'; }

# get_import <rid> → echoes "<http_code> <body>"
get_import() {
  local tmp; tmp="$(mktemp)"
  local code
  code="$(curl -s -o "$tmp" -w '%{http_code}' "${AUTH[@]}" "$API_BASE/imports/$1")"
  echo "$code $(cat "$tmp")"; rm -f "$tmp"
}

# Asserts a 200 import-detail body has an ISO createdAt and a status.
assert_detail_ok() {
  local label="$1" code="$2"; shift 2; local body="$*"
  if [ "$code" != "200" ]; then fail "$label: expected 200, got $code — $body"; return; fi
  pass "$label: 200 (no 500)"
  echo "$body" | python3 -c '
import sys, json, datetime
d = json.load(sys.stdin)
ca = d.get("createdAt")
assert isinstance(ca, str) and ca, f"createdAt missing/not-a-string: {ca!r}"
# Must parse as an ISO timestamp.
datetime.datetime.fromisoformat(ca.replace("Z", "+00:00"))
assert "rid" in d and "config" in d, "missing rid/config"
print("    createdAt =", ca, "| status =", json.dumps(d.get("status")))
' && pass "$label: createdAt is a valid ISO string + body well-formed" \
   || fail "$label: body shape/timestamp invalid"
}

echo
info "TEST 1 — create a fresh import, then GET it (create → read round-trip)"
NEW_IMP="$(curl -sf "${AUTH[@]}" "${JSON[@]}" -H "Idempotency-Key: $(uu)" \
  -X POST "$API_BASE/connections/$SOURCE_RID/imports" \
  -d "{\"connectionRid\":\"$SOURCE_RID\",\"datasetRid\":\"ri.foundry.main.dataset.$(uu)\",\"displayName\":\"verify-detail-$(uu | cut -c1-8)\",\"config\":{\"schema\":\"public\",\"table\":\"users\",\"mode\":\"snapshot\"}}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["rid"])')"
echo "  created import: $NEW_IMP"
read -r CODE BODY < <(get_import "$NEW_IMP")
assert_detail_ok "GET fresh import" "$CODE" "$BODY"

echo
info "TEST 2 — GET /imports/:rid/builds returns 200"
BCODE="$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API_BASE/imports/$NEW_IMP/builds")"
[ "$BCODE" = "200" ] && pass "builds list: 200" || fail "builds list: expected 200, got $BCODE"

echo
info "TEST 3 — GET on every existing import for the source is 200 (no 500s)"
IMP_LIST="$(curl -sf "${AUTH[@]}" "$API_BASE/connections/$SOURCE_RID/imports" \
  | python3 -c 'import sys,json;[print(i["rid"]) for i in json.load(sys.stdin).get("imports",[])]')"
TOTAL=0; OK=0
while IFS= read -r rid; do
  [ -n "$rid" ] || continue
  TOTAL=$((TOTAL + 1))
  read -r C _ < <(get_import "$rid")
  if [ "$C" = "200" ]; then OK=$((OK + 1)); else echo "    $C  $rid"; fi
done <<< "$IMP_LIST"
echo "  $OK/$TOTAL imports returned 200"
[ "$OK" = "$TOTAL" ] && pass "all $TOTAL existing imports readable" || fail "$((TOTAL - OK)) import(s) did not return 200"

if [ "${1:-}" != "" ]; then
  echo
  info "TEST 4 — caller-supplied rid $1"
  read -r CODE BODY < <(get_import "$1")
  assert_detail_ok "GET $1" "$CODE" "$BODY"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m\n'; exit 0
else
  printf '\033[31m%d CHECK(S) FAILED\033[0m\n' "$FAILURES"; exit 1
fi
