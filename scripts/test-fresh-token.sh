#!/bin/bash
# ---------------------------------------------------------------------------
# Tellus Fresh Token Diagnostic Script
#
# Fetches a fresh Keycloak token and immediately invokes the API
# ---------------------------------------------------------------------------

KEYCLOAK_URL="http://localhost:8086"
REALM="tellus"
BACKEND_URL="http://localhost:3000"
RID="ri.stemma.main.repository.758be4a2-9f09-4488-a82f-492d83cd6e33"
CLIENT_ID="tellus-frontend"  # Update if different

# We need your local superadmin credentials to fetch the token programmatically
# These correspond to the TELLUS_SUPERADMIN_EMAIL / PASSWORD in your .env
USERNAME="habimanaolivier6@gmail.com"
PASSWORD="Olivier0?Tellus"

echo "====================================================================="
echo "       REQUESTING FRESH KEYCLOAK TOKEN"
echo "====================================================================="

# 1. Fetch Token from Keycloak using Direct Access Grants
RESPONSE=$(curl -s -X POST "${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${USERNAME}" \
  -d "password=${PASSWORD}" \
  -d "grant_type=password" \
  -d "client_id=${CLIENT_ID}")

ACCESS_TOKEN=$(echo "$RESPONSE" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
    echo -e "\e[31m[FAIL] Failed to obtain access token from Keycloak.\e[0m"
    echo "Response: $RESPONSE"
    exit 1
fi

echo -e "\e[32m[PASS] Obtained fresh access token.\e[0m"

# 2. Extract Expiry and Current Time
PAYLOAD=$(echo "$ACCESS_TOKEN" | cut -d'.' -f2 | base64 --decode 2>/dev/null)
EXP_TIME=$(echo "$PAYLOAD" | grep -o '"exp":[0-9]*' | cut -d':' -f2)
CURRENT_TIME=$(date +%s)
TIME_LEFT=$((EXP_TIME - CURRENT_TIME))

echo "   Token is valid for: $TIME_LEFT seconds"

echo -e "\n====================================================================="
echo "       INVOKING TELLUS API WITH FRESH TOKEN"
echo "====================================================================="

curl -i -X GET "${BACKEND_URL}/api/v1/code-repositories/${RID}" \
  -H 'Accept: application/json, text/plain, */*' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Connection: keep-alive"

echo -e "\n\nDiagnostic complete."
