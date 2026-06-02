#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# create-pg-connection.sh
#
# Creates a PostgreSQL data connection in Tellus via the backend API.
# Steps:
#   1. Obtain auth token via test login bypass
#   2. Insert a Compass folder resource into the DB (required FK parent)
#   3. POST /api/v1/connectivity/connections to create the connection
#   4. Verify the connection exists and is listable
# ---------------------------------------------------------------------------

set -euo pipefail

# --- Configuration -----------------------------------------------------------
BACKEND_URL="http://localhost:3000"
DB_CONTAINER="e6f09c30a148"
DB_USER="tellus"
DB_NAME="tellus_db"
TEST_EMAIL="${TEST_EMAIL:-cypress@tellus.local}"
TEST_PASSWORD="${TEST_PASSWORD:-Password123!}"

# Connection parameters — these point to the LOCAL Docker PostgreSQL
# (the same instance running in docker-compose). In production this
# would point to an external database.
PG_HOST="host.docker.internal"
PG_PORT=5432
PG_DATABASE="tellus_db"
PG_USER="tellus"
PG_PASSWORD="tellus"

FOLDER_RID="ri.compass.main.folder.$(python3 -c 'import uuid; print(uuid.uuid4())')"
CONNECTION_NAME="local-postgres"

echo "============================================"
echo "  Tellus PostgreSQL Connection Creator"
echo "============================================"
echo ""

# --- Step 1: Get auth token via test bypass ----------------------------------
echo "[1/4] Authenticating via test login bypass..."

TOKEN_RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/v1/auth/_test/login-bypass" \
  -H "Content-Type: application/json" \
  -H "X-Tellus-Test-Hook: 1" \
  -d "{\"username\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")

TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['accessToken'])" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to obtain auth token."
  echo "Response: $TOKEN_RESPONSE"
  echo ""
  echo "Trying standard login endpoint..."
  
  TOKEN_RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
  
  TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['accessToken'])" 2>/dev/null || true)
  
  if [ -z "$TOKEN" ]; then
    echo "ERROR: Could not obtain token from either endpoint."
    echo "Response: $TOKEN_RESPONSE"
    exit 1
  fi
fi

echo "  Token obtained: ${TOKEN:0:20}..."
echo ""

# --- Step 2: Get a user ID for created_by ------------------------------------
echo "[2/4] Looking up user ID..."

USER_ID=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
  -c "SELECT id FROM users WHERE email = '${TEST_EMAIL}' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')

if [ -z "$USER_ID" ]; then
  # Fallback: use the first available user
  USER_ID=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT id FROM users LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
fi

echo "  User ID: $USER_ID"
echo ""

# --- Step 3: Insert Compass folder resource ----------------------------------
echo "[3/4] Creating Compass folder resource..."

# Check if a folder already exists for reuse
EXISTING_FOLDER=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
  -c "SELECT rid FROM resources WHERE type = 'FOLDER' AND trash_status = 'NOT_TRASHED' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')

if [ -n "$EXISTING_FOLDER" ]; then
  FOLDER_RID="$EXISTING_FOLDER"
  echo "  Reusing existing folder: $FOLDER_RID"
else
  # Derive a project rid and space rid (both required by resources constraints)
  PROJECT_RID=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT rid FROM resources WHERE type = 'PROJECT' AND trash_status = 'NOT_TRASHED' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
  SPACE_RID=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
    -c "SELECT rid FROM resources WHERE type = 'COMPASS_SPACE' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')

  # Fall back to root space if none found
  if [ -z "$SPACE_RID" ]; then
    SPACE_RID="ri.compass.main.space.00000000-0000-0000-0000-000000000000"
  fi

  # Build the INSERT — handle nullable project_rid cleanly
  if [ -n "$PROJECT_RID" ]; then
    SQL="INSERT INTO resources (rid, service, type, display_name, description, project_rid, space_rid, created_by, updated_by, metadata) VALUES ('${FOLDER_RID}', 'compass', 'FOLDER', 'Data Connections', 'Parent folder for PostgreSQL data connections', '${PROJECT_RID}', '${SPACE_RID}', '${USER_ID}'::uuid, '${USER_ID}'::uuid, '{}'::jsonb);"
  else
    SQL="INSERT INTO resources (rid, service, type, display_name, description, space_rid, created_by, updated_by, metadata) VALUES ('${FOLDER_RID}', 'compass', 'FOLDER', 'Data Connections', 'Parent folder for PostgreSQL data connections', '${SPACE_RID}', '${USER_ID}'::uuid, '${USER_ID}'::uuid, '{}'::jsonb);"
  fi
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "$SQL" 2>&1
  echo "  Created folder: $FOLDER_RID (space: $SPACE_RID)"
fi
echo ""

# --- Step 4: Create the connection via API -----------------------------------
echo "[4/4] Creating PostgreSQL connection via API..."

# Build the request payload
PAYLOAD=$(cat <<EOF
{
  "name": "${CONNECTION_NAME}",
  "description": "Local PostgreSQL database running in Docker (tellus_db).",
  "connectorType": "postgresql",
  "workerType": "foundryWorker",
  "config": {
    "connectorType": "postgresql",
    "postgres": {
      "host": "${PG_HOST}",
      "port": ${PG_PORT},
      "database": "${PG_DATABASE}",
      "user": "${PG_USER}",
      "applicationName": "tellus-magritte",
      "tlsMode": "disable",
      "connectTimeoutMs": 5000,
      "socketTimeoutMs": 60000,
      "poolMax": 4
    }
  },
  "egressPolicy": {
    "allowlist": [
      {
        "kind": "host",
        "host": "${PG_HOST}",
        "port": ${PG_PORT}
      }
    ]
  },
  "compassFolderRid": "${FOLDER_RID}"
}
EOF
)

# Generate idempotency key
IDEM_KEY=$(python3 -c 'import uuid; print(uuid.uuid4())')

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BACKEND_URL}/api/v1/connectivity/connections" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Idempotency-Key: ${IDEM_KEY}" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "  HTTP Status: $HTTP_CODE"

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  CONN_RID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['rid'])" 2>/dev/null || echo "unknown")
  echo "  Connection created: $CONN_RID"
  echo "  Name: $CONNECTION_NAME"
  echo ""
  
  # --- Step 5: Verify --------------------------------------------------------
  echo "[5/5] Verifying connection..."
  
  LIST_RESPONSE=$(curl -s -X GET "${BACKEND_URL}/api/v1/connectivity/connections" \
    -H "Authorization: Bearer ${TOKEN}")
  
  CONN_COUNT=$(echo "$LIST_RESPONSE" | python3 -c "import sys, json; print(len(json.load(sys.stdin).get('data', [])))" 2>/dev/null || echo "0")
  echo "  Total connections: $CONN_COUNT"
  
  # Pretty-print the connection details
  echo "$LIST_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data.get('data', []):
    print(f\"  - {c['name']} ({c['rid']})\")
    print(f\"    Type: {c['connectorType']} | Worker: {c['workerType']}\")
    print(f\"    Status: {c['status']['state']}\")
    cfg = c.get('config', {}).get('postgres', {})
    print(f\"    Host: {cfg.get('host', '?')}:{cfg.get('port', '?')}/{cfg.get('database', '?')}\")
" 2>/dev/null || true
  
  echo ""
  echo "============================================"
  echo "  SUCCESS: PostgreSQL connection created!"
  echo "  Visit: http://localhost:3001/data-connection/sources"
  echo "============================================"
else
  echo "  ERROR: Connection creation failed."
  echo "  Response: $BODY"
  exit 1
fi
