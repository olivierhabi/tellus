#!/bin/bash
# ---------------------------------------------------------------------------
# Tellus Authenticated Endpoint Diagnostic Utility
#
# Diagnoses the specific cause of 401 Stemma:Unauthenticated errors.
# ---------------------------------------------------------------------------

echo "====================================================================="
echo "       TELLUS AUTHENTICATION DIAGNOSTIC UTILITY"
echo "====================================================================="

BACKEND_URL="http://localhost:3000"
KEYCLOAK_URL="http://localhost:8086"
REALM="tellus"
RID="ri.stemma.main.repository.758be4a2-9f09-4488-a82f-492d83cd6e33"

# 1. Probe Keycloak certs endpoint accessibility
echo -e "\n1. Checking Keycloak JWKS certificates endpoint availability..."
status_code=$(curl -s -o /dev/null -w "%{http_code}" "${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/certs")

if [ "$status_code" -ne 200 ]; then
  echo -e "\e[31m[FAIL] Keycloak certificates endpoint is unreachable! (HTTP $status_code)\e[0m"
  echo "Verify if Keycloak service is running on port 8086."
else
  echo -e "\e[32m[PASS] Keycloak JWKS certs endpoint is accessible. (HTTP 200)\e[0m"
fi

# 2. Extract and print JWT Details from Bearer Token
TOKEN="eyJhbGciOiJSUzI1NiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI4cjhIbTJQUjBMTENfeHJLUlVrRXJaTWZRcGd1ZFBHTXVtZXg1enhfQmxJIn0.eyJleHAiOjE3ODIwNzQxNDksImlhdCI6MTc4MjA3Mzg0OSwianRpIjoiZTlkN2M0ZjktYzNjYi00OWEyLWJmNjMtMDUyYjAxNjdjMmJmIiwiaXNzIjoiaHR0cDovL2xvY2FsaG9zdDo4MDg2L3JlYWxtcy90ZWxsdXMiLCJhdWQiOiJhY2NvdW50Iiwic3ViIjoiNmQzODdlN2UtODllZC00NWIwLTliOGYtNGQyN2JkODM0ZDk3IiwidHlwIjoiQmVhcmVyIiwiYXpwIjoidGVsbHVzLWZyb250ZW5kIiwic2lkIjoiMTA2ZmFiMTgtMGI5Yy00M2EyLWIzYzItNGZjYWFhYWM4YTNhIiwiYWNyIjoiMSIsImFsbG93ZWQtb3JpZ2lucyI6WyJodHRwOi8vbG9jYWxob3N0OjMwMDEiLCJodHRwOi8vbG9jYWxob3N0OjMwMDAiXSwicmVhbG1fYWNjZXNzIjp7InJvbGVzIjpbInRlbGx1cy1zdXBlcmFkbWluIiwib2ZmbGluZV9hY2Nlc3MiLCJ1bWFfYXV0aG9yaXphdGlvbiIsImRlZmF1bHQtcm9sZXMtdGVsbHVzIl19LCJyZXNvdXJjZV9hY2Nlc3MiOnsiYWNjb3VudCI6eyJyb2xlcyI6WyJtYW5hZ2UtYWNjb3VudCIsIm1hbmFnZS1hY2NvdW50LWxpbmtzIiwidmlldy1wcm9maWxlIl19fSwic2NvcGUiOiJvcGVuaWQgZW1haWwgb2ZmbGluZV9hY2Nlc3MgcHJvZmlsZSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJuYW1lIjoiaGFiaW1hbmFvbGl2aWVyNi BVc2VyIiwicHJlZmVycmVkX3VzZXJuYW1lIjoiaGFiaW1hbmFvbGl2aWVyNkBnbWFpbC5jb20iLCJnaXZlbl9uYW1lIjoiaGFiaW1hbmFvbGl2aWVyNiIsImZhbWlseV9uYW1lIjoiVXNlciIsImVtYWlsIjoiaGFiaW1hbmFvbGl2aWVyNkBnbWFpbC5jb20ifQ.jzH-TOtsMoa-0HW9s_pMyjWG27p8NcSHR9NnUsF6PYio0pjSYNPBpshNgg4DXyhG9F2jwTzT5YkLoYZuLKVvoiWA8RwXGSe75izqAZdL99rsWG6iUM9Ha8T-OGaaqp5xT6DTk8TOPCCT27d7rAoNtviBEzDuysOOq1oKqxb_PsNHHaGZfqAfvUVqm2PA4DdnX3Wxa7M4uiJSIHdR_aXJ3cNt6i2-nCftYHfuWaNhWeaqRjZfDfSCVtIFRW7cMNgqCZLaPqTH09D5TAapHMYMczA7Pp5nMSDJ7ZAnAdSmiWpvFRlfXqXvPLaSt02dOee_rDb-4U7QTPmiEhxQ38wgzg"

echo -e "\n2. Analyzing your token claims..."
HEADER=$(echo "$TOKEN" | cut -d'.' -f1 | base64 --decode 2>/dev/null)
PAYLOAD=$(echo "$TOKEN" | cut -d'.' -f2 | base64 --decode 2>/dev/null)

echo " - JWT Header: $HEADER"
echo " - JWT Payload: $PAYLOAD"

# Check token expiration
EXP_TIME=$(echo "$PAYLOAD" | grep -o '"exp":[0-9]*' | cut -d':' -f2)
CURRENT_TIME=$(date +%s)

if [ -n "$EXP_TIME" ]; then
  if [ "$CURRENT_TIME" -gt "$EXP_TIME" ]; then
    echo -e "\e[31m[FAIL] Your token is EXPIRED!\e[0m"
    echo "   Token Expiration: $(date -r $EXP_TIME)"
    echo "   Current Host Time: $(date -r $CURRENT_TIME)"
    echo "   Please mint a fresh JWT of keycloak!"
  else
    echo -e "\e[32m[PASS] Token is still valid on expiration.\e[0m"
  fi
fi

# 3. Test active API request with verification details
echo -e "\n3. Invoking the target API endpoint and looking at response headers..."
curl -i -X GET "${BACKEND_URL}/api/v1/code-repositories/${RID}" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -b "TELLUS_TOKEN=${TOKEN}"

echo -e "\n====================================================================="
echo "Diagnostic Finished."
