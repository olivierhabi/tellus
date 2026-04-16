#!/usr/bin/env bash
#
# feature-coverage-matrix.sh
# --------------------------
# For each of the 120 features listed in
# `tellus-fe/ontology/ontology-object explorer.md`, emit one row showing
# which test layers cover it:
#
#   • B  — backend probe in verify-features.sh hits a real route
#   • C  — Cypress walks a UI page that exercises this feature
#   • D  — backend route or page transits a non-trivial docker container
#          (Postgres / OpenSearch / Redpanda / Prometheus / pgvector / Debezium)
#
# Output format:
#   #NN  [BCD]  Feature title
#
# A feature is "fully covered" when all three columns are present.
# Features that are pure UI-flair (drag-and-drop reorder) get a [_C_]
# pattern and are still considered covered because the page renders.
#
# This is a TRACEABILITY matrix — it does not run the tests itself. To
# actually run them: ./scripts/full-stack-audit.sh

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

#
# row <id> <B|.> <C|.> <D|.> <title>
#
TOTAL=0
FULL=0
PARTIAL=0
UNCOVERED=0

row() {
  local id="$1" b="$2" c="$3" d="$4" title="$5"
  TOTAL=$((TOTAL + 1))
  local pattern="[${b}${c}${d}]"
  local covered=0
  [[ "$b" == "B" || "$c" == "C" || "$d" == "D" ]] && covered=1
  local color="$GREEN"
  if [[ "$b$c$d" == "BCD" ]]; then
    FULL=$((FULL + 1))
  elif [[ $covered -eq 1 ]]; then
    PARTIAL=$((PARTIAL + 1))
    color="$YELLOW"
  else
    UNCOVERED=$((UNCOVERED + 1))
    color="$DIM"
  fi
  printf "${color}  #%-3s  %-7s  %s${NC}\n" "$id" "$pattern" "$title"
}

section() {
  echo
  echo -e "${BOLD}── $1 ──${NC}"
}

echo -e "${BOLD}════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Feature coverage matrix — 120 features × 3 test layers${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════════${NC}"
echo "  Legend: B = backend bash probe   C = Cypress UI walk   D = docker container transit"
echo

#                                                       B  C  D
section "1.1 Navigation & Discovery"
row 1  B C D "Top-bar global search across all resources"
row 2  B C D "Top-bar — Create New Resource (object/link/action)"
row 3  B C .  "Branch selector (= ontologies list)"
row 4  B C D "Sidebar resource navigation tree"
row 5  B C D "Discover view — landing page"
row 6  . C .  "Favorites (preferences)"

section "1.2 Object Type Management"
row 7  B C D "Create object type"
row 8  B C D "Add backing datasource"
row 9  B C D "Property configuration"
row 10 B C .  "Derived properties (function-backed)"
row 11 B C .  "Struct properties"
row 12 B C D "Vector properties (pgvector)"
row 13 B C D "Time series properties (TimescaleDB hypertable + plain fallback)"
row 14 B C D "Primary key configuration"
row 15 B C D "Multi-datasource objects"
row 16 B C D "Object type status (active/exp/endorsed/deprecated)"
row 17 B C .  "Point of contact"
row 18 B C D "Object type groups"
row 19 B C D "Metadata widget"

section "1.3 Link Type Management"
row 20 B C D "Create link type"
row 21 B C D "Foreign key links"
row 22 B C .  "Many-to-many via join table"
row 23 B C .  "Object-backed links"
row 24 B C .  "Link direction (analysis)"

section "1.4 Action Type Management"
row 25 B C D "Create action type"
row 26 B C D "Action parameters"
row 27 B . .  "Submission criteria (validate)"
row 28 B . .  "Action rules / impact"
row 29 B . D  "Side effects (Kafka publish on apply)"
row 30 B . .  "Function-backed actions"
row 31 B C D "Action audit log"
row 32 B C .  "Undo / revert (edits)"
row 33 B C .  "Inline edit actions"
row 34 B . .  "Bulk actions"
row 35 B C D "Near-real-time action metrics (Prometheus)"
row 36 B C D "Action run history"

section "1.5 Function Type Management"
row 37 B C .  "Function overview"
row 38 . C .  "Version selector"
row 39 . C .  "Open in code repo (deep link)"
row 40 B C .  "Usage history"
row 41 B C D "Function observability (Prometheus)"
row 42 . C .  "Branched functions"

section "1.6 Interface Management"
row 43 B C .  "Create interface"
row 44 B C .  "Interface inheritance"
row 45 B C .  "Interface property mapping"
row 46 B C .  "Polymorphic queries"

section "1.7 Indexing & Observability"
row 47 B C D "Funnel batch pipeline view"
row 48 B C D "Funnel streaming pipeline view (Flink JM proxy live)"
row 49 B C D "Indexing health dashboard"
row 50 B C .  "Schema migration manager"
row 51 B C D "Reindexing trigger (Debezium CDC into Kafka)"

section "1.8 Usage & Governance"
row 52 B C D "Usage graph (Prometheus counters)"
row 53 B C D "Detailed usage tab (audit log)"
row 54 B C .  "Ontology branching — proposals"
row 55 B C .  "Workflow lineage"
row 56 B C D "Ontology settings (configuration)"

section "1.9 Security Configuration"
row 57 B C D "Object security policies (Keycloak token introspected)"
row 58 B C D "Property security policies (Keycloak realm roles)"
row 59 B C D "Mandatory control properties (Keycloak claims)"
row 60 B C D "Ontology roles (Keycloak realm roles, JWKS-validated)"

section "2.1 Object Explorer Home & Discovery"
row 61 B C D "Home page hub (object types list)"
row 62 B C D "Object type groups visual grid"
row 63 B C D "Group graph visualization (Cytoscape)"
row 64 B C D "Object type preview"

section "2.2 Global Search"
row 65 B C D "Cross-ontology search"
row 66 B C .  "Type-ahead results"
row 67 B C .  "Search results page"
row 68 B C .  "Boolean operators"
row 69 B . .  "Wildcards"
row 70 B . .  "Fuzzy match"
row 71 B . .  "Exact phrase"
row 72 B C .  "Object-hover link exploration"

section "2.3 Charts / Filters (Polars-backed)"
row 73 B C D "Auto-generated charts (Polars aggregator)"
row 74 B C D "Listogram"
row 75 B C D "Histogram"
row 76 B C D "Date histogram"
row 77 B C .  "GeoHash map (MapLibre)"
row 78 B . .  "Choropleth map"
row 79 B . .  "Linked-object filtering"
row 80 . C .  "Chart drag-and-drop reorder (UI)"
row 81 . C .  "Chart resize (UI)"
row 82 B C .  "Undo/redo state (5 levels)"
row 83 B . .  "Search bar filters"
row 84 B C .  "Preview cards right sidebar"

section "2.4 Results Table View"
row 85 B C .  "Infinite-scroll table (TanStack Table)"
row 86 B C .  "Column sorting"
row 87 B C .  "Column reorder"
row 88 B C .  "Freeze columns"
row 89 B C .  "Column visibility"
row 90 B C .  "Selection preview panel"
row 91 B . .  "Compare two objects"
row 92 B . .  "Inline property editing"
row 93 B C D "Time series in table (TimescaleDB)"
row 94 B C .  "Value formatting (render hints)"
row 95 B . .  "Conditional formatting"

section "2.5 Object View"
row 96 B C D "Default object view"
row 97 B . .  "Custom object view"
row 98 B . .  "Full vs panel object view"
row 99 B C .  "Linked objects table widget"
row 100 B C D "Event timeline widget"
row 101 B C .  "Map widget (MapLibre)"
row 102 B C D "Time series chart in object view"
row 103 . C .  "Embedded applications (UI)"
row 104 B . .  "Edit object view"

section "2.6 Comparison Views"
row 105 B C .  "Compare two object sets"
row 106 B . .  "Dynamic filtering in comparison"
row 107 B . .  "Compare from saved exploration"
row 108 B . .  "Save / share comparison"

section "2.7 Actions & Export"
row 109 B C D "Actions dropdown"
row 110 B C .  "Open in… menu"
row 111 B C .  "Export to CSV/XLSX"
row 112 B . .  "Dynamic object sets"
row 113 B C .  "Success toast deep link"

section "2.8 Saved Explorations & Layouts"
row 114 B C .  "Save exploration"
row 115 B C .  "Revisit saved exploration"
row 116 B C .  "Save layout"
row 117 B . .  "Personal default layout"
row 118 B . .  "Global default layout (admin)"

section "2.9 SQL Analysis (Furnace = DuckDB)"
row 119 B C D "Analyze using SQL (Furnace SQL editor + Monaco)"
row 120 B C D "Ontology SQL via Furnace + Iceberg/Nessie catalog ready"

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
echo
echo -e "${BOLD}════════════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Coverage summary${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════════════════════════${NC}"
printf "  Total features          : %d\n" "$TOTAL"
printf "  ${GREEN}Fully covered (BCD)${NC}     : %d\n" "$FULL"
printf "  ${YELLOW}Partially covered${NC}       : %d\n" "$PARTIAL"
printf "  ${DIM}Uncovered${NC}               : %d\n" "$UNCOVERED"
echo
local_pct() {
  awk "BEGIN { printf \"%.1f\", $1 * 100 / $TOTAL }"
}
printf "  Full coverage           : %s%%\n" "$(local_pct $FULL)"
printf "  Any coverage            : %s%%\n" "$(local_pct $((FULL + PARTIAL)))"
echo
echo -e "${DIM}Note: this is a TRACEABILITY matrix only — it documents which test"
echo -e "layer covers each feature. Run ./scripts/full-stack-audit.sh to actually"
echo -e "exercise them end-to-end.${NC}"
echo
