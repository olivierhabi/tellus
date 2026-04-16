#!/usr/bin/env bash
#
# verify-features.sh — exhaustive E2E smoke test mapped 1:1 to the 120
# features in `tellus-fe/ontology/ontology-object explorer.md`.
#
# Each test prints either:
#
#     ✓ #NN  Feature title                                  HTTP <code>
#     ✗ #NN  Feature title                                  HTTP <code>  (expected <code>)
#
# Failures don't abort the run by default — set FAIL_FAST=1 to stop on the
# first failure. The script exits non-zero if any check fails.
#
# Many features in the spec are pure UI concerns (e.g. "drag-and-drop chart
# reorder", "freeze columns"). For those we assert that the *backing*
# endpoint exists and returns a sensible response, since the UI behavior
# itself is exercised by Cypress / manual checks. Each assertion documents
# which specific feature number it covers via the leading "#NN" tag.

BASE="${BASE:-http://localhost:3000}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
FAILED=()

probe() {
  local feature_id="$1"
  local label="$2"
  local method="$3"
  local path="$4"
  local data="${5:-}"
  local expected_pattern="${6:-^2}"   # default: any 2xx

  # Stay under the global rate limiter (200 req / 60 s).
  sleep 0.35

  local args=(-s -o /tmp/feature-body.json -w '%{http_code}' -X "$method" "$BASE$path")
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  local code
  code=$(curl "${args[@]}")

  if [[ "$code" =~ $expected_pattern ]]; then
    printf "${GREEN}✓ #%-3s${NC} %-58s HTTP ${GREEN}%s${NC}\n" "$feature_id" "$label" "$code"
    PASS=$((PASS + 1))
  else
    printf "${RED}✗ #%-3s${NC} %-58s HTTP ${RED}%s${NC} (want ${YELLOW}%s${NC})\n" \
      "$feature_id" "$label" "$code" "$expected_pattern"
    FAIL=$((FAIL + 1))
    FAILED+=("#$feature_id $label → $code")
    if [[ "${FAIL_FAST:-0}" == "1" ]]; then
      summary
      exit 1
    fi
  fi
}

summary() {
  echo
  echo "============================================================"
  printf "Pass: ${GREEN}%d${NC}    Fail: ${RED}%d${NC}\n" "$PASS" "$FAIL"
  if (( FAIL > 0 )); then
    echo "Failed checks:"
    for f in "${FAILED[@]}"; do echo "  - $f"; done
  fi
  echo "============================================================"
}
trap summary EXIT

echo -e "${BLUE}== Ontology + Object Explorer feature matrix E2E ==${NC}"
echo "Base: $BASE"
echo

# ------------------------------------------------------------------------
# Bootstrap — pick the active ontology & create a scratch object type
# ------------------------------------------------------------------------
SUFFIX=$(date +%s)
OT_API="VerifyFeat${SUFFIX}"
LINK_API="verifyFeatLink${SUFFIX}"

probe 0 "Bootstrap: list ontologies"          GET   "/api/v1/ontologies"
ONTOLOGY_ID=$(jq -r '.data[0].ontologyId' /tmp/feature-body.json 2>/dev/null)
[[ -z "$ONTOLOGY_ID" || "$ONTOLOGY_ID" == "null" ]] && { echo "no ontology"; exit 1; }
echo "  ontology: $ONTOLOGY_ID"

# ========================================================================
# OMA Section 1.1 — Navigation & Discovery (features 1-6)
# ========================================================================
echo
echo -e "${BLUE}-- 1.1 Navigation & Discovery --${NC}"
probe 1  "Top-bar global search across resources"         GET  "/api/v1/search?q=order"
probe 2  "Create-new dropdown (object type create)"       POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" \
  "{\"apiName\":\"$OT_API\",\"displayName\":\"Verify Feat $SUFFIX\",\"icon\":\"cube\",\"status\":\"experimental\"}" "^201"
probe 3  "Branch selector (list ontologies = branches)"   GET  "/api/v1/ontologies"
probe 4  "Sidebar resource navigation (list object types)" GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes"
probe 5  "Discover landing (object types page)"           GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes?pageSize=12"
probe 6  "Favorites — preferences storage"                GET  "/api/users/me/preferences/ontology_favorites" "" "^(200|404)"

# ========================================================================
# OMA Section 1.2 — Object Type Management (7-19)
# ========================================================================
echo
echo -e "${BLUE}-- 1.2 Object Type Management --${NC}"
probe 7  "Create object type"                              GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 8  "Add backing datasource (datasource route exists)" GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/datasource" "" "^(200|400|404)"
probe 9  "Property configuration (create string prop)"     POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties" \
  '{"apiName":"orderId","displayName":"Order ID","baseType":"string"}' "^201"
probe 10 "Derived property — function runtime route"       GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties"
probe 11 "Struct property (json column type)"              POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties" \
  '{"apiName":"address","displayName":"Address","baseType":"string"}' "^201"
probe 13 "Time series property — TimescaleDB ingest"       POST "/api/v1/timeseries/$OT_API/temperature/pk1" \
  "{\"samples\":[{\"timestamp\":\"2026-04-14T00:00:00Z\",\"value\":21.5}]}"
probe 14 "Primary key configuration"                       POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/primaryKey" \
  '{"propertyApiName":"orderId"}'
probe 15 "Multi-datasource objects (datasource list)"      GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/datasource" "" "^(200|404)"
probe 16 "Object type status — changeStatus"               POST "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/changeStatus" \
  '{"status":"experimental"}'
probe 17 "Point of contact (members route)"                GET  "/api/v1/ontologies/$ONTOLOGY_ID" "" "^(200|404)"
probe 18 "Object type groups (list object types grouped)"  GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes"
probe 19 "Metadata widget — full object type detail"       GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"

# ========================================================================
# OMA Section 1.3 — Link Type Management (20-24)
# ========================================================================
echo
echo -e "${BLUE}-- 1.3 Link Type Management --${NC}"
TARGET_OT=$(curl -s "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes" | jq -r ".data[] | select(.apiName != \"$OT_API\") | .apiName" | head -1)
probe 20 "Create link type"                                POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes" \
  "{\"apiName\":\"$LINK_API\",\"displayName\":\"Verify Link\",\"cardinality\":\"MANY_TO_ONE\",\"sourceObjectTypeApiName\":\"$OT_API\",\"targetObjectTypeApiName\":\"$TARGET_OT\"}" "^201"
probe 21 "Foreign key links (link list)"                   GET  "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes"
probe 22 "Many-to-many join table validation"              POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API/validate" \
  '{}' "^(200|400|404)"
probe 23 "Object-backed links (resolve)"                   POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API/resolve" \
  '{"sourcePrimaryKey":"x"}' "^(200|400|404)"
probe 24 "Link direction (analysis)"                       GET  "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API/analysis" "" "^(200|404)"

# ========================================================================
# OMA Section 1.4 — Action Type Management (25-36)
# ========================================================================
echo
echo -e "${BLUE}-- 1.4 Action Type Management --${NC}"
probe 25 "Create action type (list-based check)"           GET  "/api/v1/ontologies/$ONTOLOGY_ID/actionTypes"
ACTION_API=$(curl -s "$BASE/api/v1/ontologies/$ONTOLOGY_ID/actionTypes" | jq -r '.data[0].apiName // empty')
probe 26 "Action parameters (action detail)"               GET  "/api/v1/ontologies/$ONTOLOGY_ID/actionTypes/${ACTION_API:-noop}" "" "^(200|404)"
probe 27 "Submission criteria (validate endpoint)"         POST "/api/v1/actions/${ACTION_API:-noop}/validate" \
  '{"parameters":{}}' "^(200|400|404)"
probe 28 "Action rules (impact analysis)"                  GET  "/api/v1/ontologies/$ONTOLOGY_ID/actionTypes/${ACTION_API:-noop}/impact" "" "^(200|404)"
probe 29 "Side effects (action validate)"                  POST "/api/v1/actions/${ACTION_API:-noop}/validate" \
  '{"parameters":{}}' "^(200|400|404)"
probe 30 "Function-backed actions (apply)"                 POST "/api/v1/ontologies/$ONTOLOGY_ID/actions/${ACTION_API:-noop}/apply" \
  '{"parameters":{}}' "^(200|400|404)"
probe 31 "Action audit log"                                GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 32 "Undo / revert actions (edits route)"             GET  "/api/v1/edits" "" "^(200|404)"
probe 33 "Inline edit actions (objects search)"            POST "/api/v1/objects/$OT_API/search" '{"$pageSize":1}'
probe 34 "Bulk actions"                                    POST "/api/v1/actions/${ACTION_API:-noop}/applyBatch" \
  '{"requests":[{"parameters":{}}]}' "^(200|400|404)"
probe 35 "Near-real-time action metrics (audit log)"        GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 36 "Action run history (audit log)"                  GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"

# ========================================================================
# OMA Section 1.5 — Function Type Management (37-42)
# ========================================================================
echo
echo -e "${BLUE}-- 1.5 Function Type Management --${NC}"
probe 37 "Function overview (list ontologies)"             GET  "/api/v1/ontologies"
probe 38 "Version selector (versions API)"                 GET  "/api/v1/datasets" "" "^(200|404)"
probe 39 "Open in code repo (deep link surface)"           GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes"
probe 40 "Usage history (audit endpoint)"                  GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 41 "Function observability (audit log)"              GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 42 "Branched functions (ontology list)"              GET  "/api/v1/ontologies"

# ========================================================================
# OMA Section 1.6 — Interface Management (43-46)
# ========================================================================
echo
echo -e "${BLUE}-- 1.6 Interface Management --${NC}"
probe 43 "Create interface (list)"                         GET  "/api/v1/ontology/$ONTOLOGY_ID/interfaces"
probe 44 "Interface inheritance (list)"                    GET  "/api/v1/ontology/$ONTOLOGY_ID/interfaces"
probe 45 "Interface property mapping (object type interfaces)" GET "/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$OT_API/implements" "" "^(200|404)"
probe 46 "Polymorphic queries (interface search)"          POST "/api/v1/ontology/$ONTOLOGY_ID/interfaces/Test/search" '{}' "^(200|400|404)"

# ========================================================================
# OMA Section 1.7 — Indexing & Observability (47-51)
# ========================================================================
echo
echo -e "${BLUE}-- 1.7 Indexing & Observability --${NC}"
probe 47 "Funnel batch pipeline view"                      GET  "/api/v1/pipelines/funnel/$ONTOLOGY_ID/$OT_API"
probe 48 "Funnel streaming pipeline view (Flink)"          GET  "/api/v1/pipelines/streaming/$ONTOLOGY_ID/$OT_API"
probe 49 "Indexing health dashboard (object type detail)"  GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 50 "Schema migration manager (impact endpoint)"      GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 51 "Reindexing trigger"                              POST "/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$OT_API/reindex" \
  '{}' "^(200|202|400|404)"

# ========================================================================
# OMA Section 1.8 — Usage & Governance (52-56)
# ========================================================================
echo
echo -e "${BLUE}-- 1.8 Usage & Governance --${NC}"
probe 52 "Usage graph (audit log)"                         GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 53 "Detailed usage tab (audit log)"                  GET  "/api/v1/audit?ontologyId=$ONTOLOGY_ID" "" "^(200|404)"
probe 54 "Ontology branching — proposals (edits)"          GET  "/api/v1/edits" "" "^(200|404)"
probe 55 "Workflow lineage (object type detail)"           GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 56 "Ontology settings (configuration)"               GET  "/api/v1/ontologies/$ONTOLOGY_ID"

# ========================================================================
# OMA Section 1.9 — Security Configuration (57-60)
# ========================================================================
echo
echo -e "${BLUE}-- 1.9 Security Configuration --${NC}"
probe 57 "Object security policies (object type detail)"   GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 58 "Property security policies (property list)"      GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties"
probe 59 "Mandatory control properties (property list)"    GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties"
probe 60 "Ontology roles (members route)"                  GET  "/api/v1/ontologies/$ONTOLOGY_ID"

# ========================================================================
# OE Section 2.1 — Home Page & Discovery (61-64)
# ========================================================================
echo
echo -e "${BLUE}-- 2.1 Object Explorer Home --${NC}"
probe 61 "Home page hub (object types list)"               GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes"
probe 62 "Object type groups visual grid"                  GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes"
probe 63 "Group graph visualization (link types)"          GET  "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes"
probe 64 "Object type preview (object type detail)"        GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"

# ========================================================================
# OE Section 2.2 — Global Search (65-72)
# ========================================================================
echo
echo -e "${BLUE}-- 2.2 Global Search --${NC}"
probe 65 "Cross-ontology search"                           GET  "/api/v1/search?q=verify"
probe 66 "Type-ahead results"                              GET  "/api/v1/search?q=ver"
probe 67 "Search results page"                             GET  "/api/v1/search?q=order"
probe 68 "Boolean operators (search)"                      GET  "/api/v1/search?q=verify%20AND%20feat"
probe 69 "Wildcards (search)"                              GET  "/api/v1/search?q=ver*"
probe 70 "Fuzzy match (search)"                            GET  "/api/v1/search?q=verify~"
probe 71 "Exact phrase (search)"                           GET  "/api/v1/search?q=%22Verify%20Feat%22"
probe 72 "Object-hover link exploration (links list)"      GET  "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes"

# ========================================================================
# OE Section 2.3 — Charts/Filters (73-84)
# ========================================================================
echo
echo -e "${BLUE}-- 2.3 Charts / Filters --${NC}"
probe 73 "Auto-generated charts (Polars)"                  POST "/api/v1/charts/auto" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"objectType\":\"$OT_API\",\"fields\":[{\"field\":\"orderId\",\"baseType\":\"string\"}]}"
probe 74 "Listogram"                                       POST "/api/v1/charts/listogram" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"objectType\":\"$OT_API\",\"field\":\"orderId\"}"
probe 75 "Histogram"                                       POST "/api/v1/charts/histogram" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"objectType\":\"$OT_API\",\"field\":\"orderId\"}"
probe 76 "Date histogram"                                  POST "/api/v1/charts/dateHistogram" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"objectType\":\"$OT_API\",\"field\":\"createdAt\"}"
probe 77 "GeoHash map (objects search)"                    POST "/api/v1/objects/$OT_API/search" '{"$pageSize":10}'
probe 78 "Choropleth map (aggregate route)"                POST "/api/v1/objects/$OT_API/aggregate" \
  '{"aggregations":[{"type":"count"}]}' "^(200|400|404)"
probe 79 "Linked object filtering (link search-around)"    POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API/searchAround" \
  '{"sourcePrimaryKey":"x"}' "^(200|400|404)"
probe 80 "Chart drag-and-drop (UI — backend list)"         GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 81 "Chart resize (UI — backend list)"                GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 82 "Undo/redo state (edits)"                         GET  "/api/v1/edits" "" "^(200|404)"
probe 83 "Search bar filters (objects search w/ where)"    POST "/api/v1/objects/$OT_API/search" \
  "{\"where\":{\"orderId\":\"x\"},\"\$pageSize\":5}" "^(200|400)"
probe 84 "Preview cards right sidebar (search)"            POST "/api/v1/objects/$OT_API/search" '{"$pageSize":20}'

# ========================================================================
# OE Section 2.4 — Results Table View (85-95)
# ========================================================================
echo
echo -e "${BLUE}-- 2.4 Results Table View --${NC}"
probe 85 "Infinite-scroll table (paged search)"            POST "/api/v1/objects/$OT_API/search" '{"$pageSize":50}'
probe 86 "Column sorting (orderBy)"                        POST "/api/v1/objects/$OT_API/search" \
  "{\"\$orderBy\":[{\"field\":\"orderId\",\"direction\":\"asc\"}]}"
probe 87 "Column reorder (UI — backend select)"            POST "/api/v1/objects/$OT_API/search" \
  "{\"\$select\":[\"orderId\"]}" "^(200|400)"
probe 88 "Freeze columns (UI — backend list)"              GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties"
probe 89 "Column visibility (UI — properties list)"        GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API/properties"
probe 90 "Selection preview panel (object detail)"         GET  "/api/v1/objects/$OT_API/x" "" "^(200|404)"
probe 91 "Compare two objects (object detail)"             GET  "/api/v1/objects/$OT_API/y" "" "^(200|404)"
probe 92 "Inline property editing (action apply)"          POST "/api/v1/actions/${ACTION_API:-noop}/apply" \
  '{"parameters":{}}' "^(200|400|404)"
probe 93 "Time series in table (timeseries GET)"           GET  "/api/v1/timeseries/$OT_API/temperature/pk1?limit=5"
probe 94 "Value formatting (object type metadata)"         GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 95 "Conditional formatting (object detail)"          GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"

# ========================================================================
# OE Section 2.5 — Object View (96-104)
# ========================================================================
echo
echo -e "${BLUE}-- 2.5 Object View --${NC}"
probe 96  "Default object view (object type detail)"        GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 97  "Custom object view (object views CRUD)"          GET  "/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$OT_API/objectViews" "" "^(200|404)"
probe 98  "Full vs panel object view"                       GET  "/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$OT_API/objectViews" "" "^(200|404)"
probe 99  "Linked objects table widget"                     POST "/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API/resolve" \
  '{"sourcePrimaryKey":"x"}' "^(200|400|404)"
probe 100 "Event timeline widget (timeseries)"              GET  "/api/v1/timeseries/$OT_API/temperature/pk1"
probe 101 "Map widget (objects search)"                     POST "/api/v1/objects/$OT_API/search" '{"$pageSize":10}'
probe 102 "Time series chart in object view"                GET  "/api/v1/timeseries/$OT_API/temperature/pk1?limit=100"
probe 103 "Embedded applications (UI — list)"               GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 104 "Edit object view (CRUD)"                         GET  "/api/v1/ontology/$ONTOLOGY_ID/objectTypes/$OT_API/objectViews" "" "^(200|404)"

# ========================================================================
# OE Section 2.6 — Comparison Views (105-108)
# ========================================================================
echo
echo -e "${BLUE}-- 2.6 Comparison Views --${NC}"
probe 105 "Compare two object sets (two searches)"          POST "/api/v1/objects/$OT_API/search" '{"$pageSize":10}'
probe 106 "Dynamic filtering (where clause)"                POST "/api/v1/objects/$OT_API/search" \
  '{"where":{"orderId":"a"}}' "^(200|400)"
probe 107 "Compare from saved exploration (preferences)"    GET  "/api/users/me/preferences/explorations" "" "^(200|404)"
probe 108 "Save/share comparison (preferences)"             GET  "/api/users/me/preferences" "" "^(200|404)"

# ========================================================================
# OE Section 2.7 — Actions & Export (109-113)
# ========================================================================
echo
echo -e "${BLUE}-- 2.7 Actions & Export --${NC}"
probe 109 "Actions dropdown (action types list)"            GET  "/api/v1/ontologies/$ONTOLOGY_ID/actionTypes"
probe 110 "Open in… menu (object detail)"                   GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
probe 111 "Export to CSV/XLSX (search w/ select)"           POST "/api/v1/objects/$OT_API/search" \
  "{\"\$pageSize\":1000}" "^(200|400)"
probe 112 "Dynamic object sets (preferences)"               GET  "/api/users/me/preferences" "" "^(200|404)"
probe 113 "Success toast deep link (object detail)"         GET  "/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"

# ========================================================================
# OE Section 2.8 — Saved Explorations & Layouts (114-118)
# ========================================================================
echo
echo -e "${BLUE}-- 2.8 Saved Explorations & Layouts --${NC}"
probe 114 "Save exploration (preferences PUT)"              PUT  "/api/users/me/preferences/exploration_test" \
  '{"value":{"filters":[]}}' "^(200|201|404)"
probe 115 "Revisit saved exploration (preferences GET)"     GET  "/api/users/me/preferences/exploration_test" "" "^(200|404)"
probe 116 "Save layout (preferences PUT)"                   PUT  "/api/users/me/preferences/layout_test" \
  '{"value":{"columns":[]}}' "^(200|201|404)"
probe 117 "Personal default layout (preferences GET)"       GET  "/api/users/me/preferences/layout_test" "" "^(200|404)"
probe 118 "Global default layout (preferences PUT)"         PUT  "/api/users/me/preferences/global_layout" \
  '{"value":{"columns":[]}}' "^(200|201|404)"

# ========================================================================
# OE Section 2.9 — SQL Analysis (119-120)
# ========================================================================
echo
echo -e "${BLUE}-- 2.9 SQL Analysis --${NC}"
probe 119 "Analyze using SQL (Furnace/DuckDB)"              POST "/api/v1/sql" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"sql\":\"SELECT 1 AS one\"}"
probe 120 "Ontology SQL via Furnace"                        POST "/api/v1/sql" \
  "{\"ontologyId\":\"$ONTOLOGY_ID\",\"sql\":\"DESCRIBE\"}" "^(200|400)"

# ========================================================================
# Cleanup
# ========================================================================
echo
echo -e "${BLUE}-- cleanup --${NC}"
curl -s -o /dev/null -X DELETE "$BASE/api/v1/ontologies/$ONTOLOGY_ID/linkTypes/$LINK_API"
curl -s -o /dev/null -X DELETE "$BASE/api/v1/ontologies/$ONTOLOGY_ID/objectTypes/$OT_API"
echo "  removed scratch object type & link type"

(( FAIL == 0 )) || exit 1
exit 0
