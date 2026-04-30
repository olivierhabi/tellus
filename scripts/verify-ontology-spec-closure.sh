#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-ontology-spec-closure.sh
#
# Confirms the 15 spec-closure fixes for ontology tasks B1–B10
# (tasks/ontology tasks.md) are present in the working tree. Static
# checks only — no Postgres / Temporal / Kafka / Quickwit / ClickHouse /
# K8s required. Run in isolation.
# ---------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0; FAIL=0

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; PASS=$((PASS+1)); }
fail() { printf "  %s✗%s %s\n" "$RED"   "$RESET" "$1"; FAIL=$((FAIL+1)); }
note() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }
hdr()  { printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"; }

assert_file() {
  if [[ -f "$1" ]]; then pass "$2 ($1)"; else fail "$2 MISSING: $1"; fi
}

assert_grep() {
  local pat="$1" file="$2" label="$3"
  if grep -qE "$pat" "$file" 2>/dev/null; then pass "$label"; else fail "$label (pattern: $pat)"; fi
}

assert_no_grep() {
  local pat="$1" file="$2" label="$3"
  if ! grep -qE "$pat" "$file" 2>/dev/null; then pass "$label"; else fail "$label (found forbidden: $pat)"; fi
}

# ---------------------------------------------------------------------------
hdr "B1  Unconditional object_edits writeback in editApplicator"
# ---------------------------------------------------------------------------
EA=src/actions/editApplicator.ts
assert_grep "resolveOntologyForObjectType" "$EA" "resolves ontologyId from object_type when not supplied"
assert_grep "SELECT ontology_id FROM object_type WHERE api_name = \\\$1" "$EA" "resolver runs inside the PG transaction"
assert_no_grep "if \\(executionContext\\.ontologyId\\) \\{" "$EA" "no conditional on executionContext.ontologyId around writeback"

# ---------------------------------------------------------------------------
hdr "B2  Iceberg write.delete.mode propagation + real metadata.json emission"
# ---------------------------------------------------------------------------
IC=src/services/funnel/icebergCatalog.ts
LK=src/services/funnel/lakekeeperClient.ts
IE=src/services/funnel/icebergMetadataEmitter.ts

assert_grep "write.delete.mode.: writeMode" "$IC" "icebergCatalog passes writeMode as table property"
assert_grep "history.expire.min-snapshots-to-keep.: String\\(minSnapshots\\)" "$IC" "min-snapshots-to-keep propagated"
assert_grep "tableProperties: Record<string, string>" "$IC" "registerTableInLakekeeper accepts properties"
assert_grep "\\.\\.\\.\\(input\\.properties \\?\\? \\{\\}\\)" "$LK" "Lakekeeper createTable spreads caller-supplied properties"

assert_file "$IE" "icebergMetadataEmitter.ts present"
assert_grep "emitIcebergMetadataForSnapshot" "$IE" "emits metadata.json per snapshot"
assert_grep "version-hint.text" "$IE" "emits Iceberg version-hint.text"
assert_grep "\"format-version\": 2" "$IE" "writes Iceberg v2 metadata"
assert_grep "emitMetadataToS3BestEffort" "$IC" "commitSnapshot invokes emitter"

# ---------------------------------------------------------------------------
hdr "B3  Numbered SQL migration for funnel_runs"
# ---------------------------------------------------------------------------
M14=src/migrations/014_funnel_runs.sql
assert_file "$M14" "numbered migration 014 exists"
assert_grep "CREATE TABLE IF NOT EXISTS funnel_run" "$M14" "funnel_run table"
assert_grep "CREATE TABLE IF NOT EXISTS funnel_stage_run" "$M14" "funnel_stage_run table"
assert_grep "CREATE TABLE IF NOT EXISTS funnel_signal" "$M14" "funnel_signal table"
assert_grep "CREATE TABLE IF NOT EXISTS funnel_changelog_watermark" "$M14" "funnel_changelog_watermark table"
assert_grep "CREATE OR REPLACE VIEW funnel_runs" "$M14" "spec-named 'funnel_runs' view"

# ---------------------------------------------------------------------------
hdr "B4  iceberg_snapshots() + naming convention + streaming"
# ---------------------------------------------------------------------------
CL=src/services/funnel/changelogStage.ts
DI=src/services/funnel/duckdbIceberg.ts
SC=src/services/funnel/streamingChangelog.ts

assert_grep "assertChangelogTableNamespace" "$CL" "namespace assertion helper"
assert_grep "funnelNamespace\\(objectTypeApiName, .changelog.\\)" "$CL" "enforces _funnel.<ot>.changelog.<ds>"
assert_grep "listIcebergSnapshots" "$DI" "iceberg_snapshots() DuckDB helper"
assert_grep "iceberg_snapshots\\(" "$DI" "calls DuckDB's iceberg_snapshots() table function"

assert_file "$SC" "streamingChangelog.ts present"
assert_grep "kafka_offsets: args.kafkaOffsets" "$SC" "offsets embedded in Iceberg snapshot summary"
assert_grep "loadOffsetsFromSnapshot" "$SC" "resumes from offsets in latest snapshot summary"
assert_grep "ThroughputGuard" "$SC" "streaming path enforces 2 MB/s throughput cap"
assert_grep "autoCommit: false" "$SC" "consumer does NOT commit Kafka offsets (Iceberg is checkpoint)"

# ---------------------------------------------------------------------------
hdr "B5  mergeChangesFromSnapshots + tombstone markings union"
# ---------------------------------------------------------------------------
MS=src/services/funnel/mergeStage.ts
assert_grep "mergeChangesFromSnapshots" "$MS" "spec-aligned changelogSnapshots[] entry point"
assert_grep "changelogSnapshots: Array<" "$MS" "accepts snapshot-id contributions"
assert_grep "carriedMarkings = new Set<string>\\(prior\\?.markings \\?\\? \\[\\]\\)" "$MS" \
  "tombstone preserves cross-datasource marking union"

# ---------------------------------------------------------------------------
hdr "B6  Kafka topic case-preservation + stable_log merge policy"
# ---------------------------------------------------------------------------
IM=src/services/quickwit/indexManager.ts
DM=src/services/quickwit/docMapping.ts
assert_no_grep "objectTypeApiName\\.toLowerCase\\(\\)" "$IM" "topic preserves api-name casing"
assert_grep "merged\\.\\\$\\{objectTypeApiName\\}" "$IM" "topic = merged.<object_type>"
assert_grep "type: \"stable_log\"" "$DM" "stable_log merge policy configured"
assert_grep "min_level_num_docs: 10_000_000" "$DM" "10M-doc compaction threshold"

# ---------------------------------------------------------------------------
hdr "B7  Sweeper reads object_edits + Prometheus SLI export"
# ---------------------------------------------------------------------------
SW=src/services/overlay/sweeper.sh 2>/dev/null || true
SW=src/services/overlay/sweeper.ts
SL=src/services/overlay/slis.ts
FR=src/routes/funnel.ts
assert_grep "FROM object_edits" "$SW" "sweeper reads object_edits (canonical B1/B7 source)"
assert_grep "renderOverlaySliPrometheus" "$SL" "Prometheus exposition for overlay SLI"
assert_grep "overlay_to_index_lag_p99_seconds" "$SL" "p99 gauge in exposition"
assert_grep "/slis/metrics" "$FR" "route wires Prometheus SLI exposition"

# ---------------------------------------------------------------------------
hdr "B8  Atomic K8s Service-selector flip"
# ---------------------------------------------------------------------------
K8=src/services/quickwit/k8sServiceFlip.ts
VM=src/services/quickwit/replacement/versionManager.ts
assert_file "$K8" "k8sServiceFlip.ts present"
assert_grep "flipSearcherServiceSelector" "$K8" "flip helper exported"
assert_grep "application/merge-patch\\+json" "$K8" "patch uses merge-patch semantics"
assert_grep "flipSearcherServiceSelector" "$VM" "versionManager.cutover invokes flip"

# ---------------------------------------------------------------------------
hdr "B9  Shadow-diff query translation + auto-trigger"
# ---------------------------------------------------------------------------
SH=src/services/funnel/shadowDiffHook.ts
RS=src/services/funnel/replacementScheduler.ts
SD=src/services/quickwit/replacement/schemaChangeDetector.ts
assert_grep "compileWhere" "$SH" "shadow-diff compiler handles full where grammar"
# Source writes each case as `case "<name>":` — match against the
# quoted form. Covers the full grammar the Object Explorer emits.
for kind in eq neq in notin gt gte lt lte between prefix contains match exists and or not; do
  assert_grep "case \"${kind}\":" "$SH" "shadow-diff handles case \"${kind}\""
done

assert_grep "autoTriggerVolumeReplacements" "$RS" "scheduler has auto-trigger stage"
assert_grep "funnel_changelog_watermark" "$RS" "auto-trigger reads changelog watermark"
assert_grep "beginReplacementBackfill" "$RS" "auto-trigger kicks off backfill"
assert_grep "AUTO_TRIGGER_THRESHOLD = 0\\.80" "$SD" "80% threshold matches Palantir heuristic"

# ---------------------------------------------------------------------------
hdr "B10 search_stream + marking filters + ClickHouse prod cluster"
# ---------------------------------------------------------------------------
QC=src/services/quickwit/client.ts
QT=src/services/searchAround/quickwitTraversal.ts
SA=src/services/searchAround/searchAroundService.ts
CHK=infra/k8s/clickhouse-cluster.yaml

assert_grep "async searchStream" "$QC" "QuickwitClient.searchStream implemented"
assert_grep "/search/stream" "$QC" "hits the /search/stream endpoint"
assert_grep "client.searchStream" "$QT" "traversal uses searchStream (not search)"
assert_grep "userMarkings\\?: ReadonlySet<string>" "$QT" "hop accepts userMarkings"
assert_grep "markings:\\*" "$QT" "hop filters out non-user-visible link docs"
assert_grep "dropPksUserCannotSee" "$SA" "service-layer post-filter"

assert_file "$CHK" "prod ClickHouse manifest present"
assert_grep "tellus_search_arounds" "$CHK" "cluster named tellus_search_arounds"
# 3 shards × 2 replicas = 6 StatefulSets named clickhouse-s{1,2,3}-r{1,2}
for s in 1 2 3; do
  for r in 1 2; do
    assert_grep "name: clickhouse-s${s}-r${r}" "$CHK" "StatefulSet shard=${s} replica=${r}"
  done
done

# ---------------------------------------------------------------------------
hdr "Static build verification"
# ---------------------------------------------------------------------------
if npx --yes tsc --noEmit >/tmp/verify-tsc.log 2>&1; then
  pass "tsc --noEmit: clean"
else
  fail "tsc --noEmit produced errors (/tmp/verify-tsc.log):"
  tail -20 /tmp/verify-tsc.log | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
hdr "Unit tests (tests/funnel/unit)"
# ---------------------------------------------------------------------------
if npx --yes vitest run tests/funnel/unit --reporter=default >/tmp/verify-vitest.log 2>&1; then
  funnel_passed=$(grep -oE '[0-9]+ passed' /tmp/verify-vitest.log | tail -1 || true)
  pass "funnel unit suite: ${funnel_passed:-all tests green}"
else
  fail "funnel unit suite failed (/tmp/verify-vitest.log tail):"
  tail -30 /tmp/verify-vitest.log | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
hdr "Summary"
# ---------------------------------------------------------------------------
printf "  %s%d passed%s / %s%d failed%s\n" "$GREEN" "$PASS" "$RESET" "$RED" "$FAIL" "$RESET"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
