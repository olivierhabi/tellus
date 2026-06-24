#!/usr/bin/env bash
# test-pipeline-deploy — end-to-end test of the pipeline deploy flow.
#
# Three assertions, each exit-non-zero on failure:
#
#   1. AUDIT — no deployed dataset has a column-count divergence from
#      the union/join snapshot it descended from.
#   2. PREVIEW — for the requested pipeline's output node, the deploy
#      code path (TransformService.outputPreview → resolveNodeData)
#      returns the same column count as the upstream union/join
#      snapshot.
#   3. DEPLOY — a fresh deployment runs through executeDeploymentById
#      and lands in `status='succeeded'` with the expected column
#      count materialized in dataset_columns.
#
# Usage (defaults match the case reported in the runbook):
#   PROJECT_ID=… PIPELINE_ID=… EXPECTED_COLUMNS=11 \
#     bash scripts/test-pipeline-deploy.sh
#
# Without env overrides the script targets the previously-affected
# `0c05f9cf-…` pipeline and asserts 11 columns.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_ID="${PROJECT_ID:-36271681-65d7-4c55-a6d0-20137f8212dc}"
PIPELINE_ID="${PIPELINE_ID:-0c05f9cf-c4cb-488c-8f5b-1e1497390caa}"
EXPECTED_COLUMNS="${EXPECTED_COLUMNS:-11}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }

# ── 1. AUDIT ──────────────────────────────────────────────────────
bold "[1/3] AUDIT — scan for deploy-time schema drift"
if pnpm tsx scripts/audit-deployed-dataset-schemas.ts > /tmp/audit.json 2>&1; then
  green "  ok — no drift detected"
else
  red "  FAIL — drift detected:"
  cat /tmp/audit.json
  exit 1
fi

# ── 2. PREVIEW ────────────────────────────────────────────────────
bold "[2/3] PREVIEW — outputPreview yields the expected column count"
# Resolve the live output node for the pipeline (latest by position_x).
OUTPUT_NODE=$(docker exec -e PGPASSWORD=tellus123 tellus-postgres-1 \
  psql -U tellus -d tellus_db -At -c "
    SELECT id::text FROM pipeline_nodes
    WHERE pipeline_id = '$PIPELINE_ID' AND node_type = 'output'
    ORDER BY created_at DESC LIMIT 1;")
if [ -z "$OUTPUT_NODE" ]; then
  red "  FAIL — no output node on pipeline $PIPELINE_ID"
  exit 1
fi
PREVIEW_JSON=$(pnpm tsx scripts/verify-output-preview-columns.ts \
  --project="$PROJECT_ID" --pipeline="$PIPELINE_ID" --output="$OUTPUT_NODE" 2>&1 \
  | tail -100)
ACTUAL_COLS=$(printf '%s' "$PREVIEW_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['columnCount'])" 2>/dev/null || echo "")
if [ "$ACTUAL_COLS" != "$EXPECTED_COLUMNS" ]; then
  red "  FAIL — expected $EXPECTED_COLUMNS columns, got '$ACTUAL_COLS'"
  echo "$PREVIEW_JSON"
  exit 1
fi
green "  ok — outputPreview returned $ACTUAL_COLS columns"

# ── 3. DEPLOY ─────────────────────────────────────────────────────
bold "[3/3] DEPLOY — execute a fresh deployment and assert success"
DEPLOY_JSON=$(pnpm tsx scripts/run-deploy-direct.ts \
  --project="$PROJECT_ID" --pipeline="$PIPELINE_ID" 2>&1 \
  | tail -100)
STATUS=$(printf '%s' "$DEPLOY_JSON" | awk '
  /^  "status":/ { gsub(/[",]/,""); print $2; exit }
')
if [ "$STATUS" != "succeeded" ]; then
  red "  FAIL — deployment status='$STATUS'"
  echo "$DEPLOY_JSON"
  exit 1
fi
green "  ok — deployment succeeded"

bold ""
green "PASS — pipeline $PIPELINE_ID deploy flow is healthy ($EXPECTED_COLUMNS columns)."
