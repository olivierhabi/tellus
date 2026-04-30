#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-ontology-fixes.sh
#
# Static verification for the three ontology-task fixes called out by the
# B1–B10 audit:
#
#   1. B1 — the polymorphic SoR table is named `object_instances` (plural,
#           per spec §B1). No code path may still reference the singular
#           `object_instance` name.
#   2. B5 — `bulkUpsertInstances` writes in batches (no per-row N+1 loop)
#           so Merge can meet the "100M rows / 50k edits in <15 min" SLO.
#   3. B3 — each Funnel activity (Changelog / Merge / Indexing / Hydration)
#           carries the per-stage `startToCloseTimeout` + retry budget
#           required by the spec, and Hydration errors are no longer
#           swallowed silently.
#
# The script only does static / typecheck / unit-test verification — it
# does not require Postgres, Temporal, Quickwit, ClickHouse, etc. Codex
# can run it in isolation.
# ---------------------------------------------------------------------------

set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
PASS=0; FAIL=0

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; PASS=$((PASS+1)); }
fail() { printf "  %s✗%s %s\n" "$RED"   "$RESET" "$1"; FAIL=$((FAIL+1)); }
note() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

# ---------------------------------------------------------------------------
# B1 — object_instances (plural) rename
# ---------------------------------------------------------------------------
echo "B1  Postgres System of Record — table is 'object_instances' (plural)"

# The only permitted `object_instance` (singular) mentions in source code
# are the rename-migration in src/migrate.ts that performs the in-place
# ALTER TABLE ... RENAME TO. Everything else must be plural.
stale=$(grep -RnE '\bobject_instance\b' \
  --include='*.ts' --include='*.sql' --include='*.sh' \
  src scripts tests 2>/dev/null \
  | grep -v 'scripts/verify-ontology-fixes.sh' \
  | grep -v 'RENAME TO object_instances' \
  | grep -v "tablename = 'object_instance'" \
  | grep -v 'Pre-spec deployments created this table as singular' || true)
if [[ -z "$stale" ]]; then
  pass "no stale singular 'object_instance' references in src/scripts/tests"
else
  fail "stale 'object_instance' references found:"
  echo "$stale" | sed 's/^/      /'
fi

# The CREATE TABLE target must be the plural name.
if grep -q 'CREATE TABLE IF NOT EXISTS object_instances' src/migrate.ts; then
  pass "src/migrate.ts creates object_instances (plural)"
else
  fail "src/migrate.ts does NOT create object_instances"
fi

# The in-place rename migration must be present so existing databases
# don't end up with two tables.
if grep -q 'ALTER TABLE object_instance RENAME TO object_instances' src/migrate.ts; then
  pass "in-place rename migration present for existing deployments"
else
  fail "rename migration missing — pre-spec databases will fork"
fi

# Every read/write from the application layer must use plural.
for f in src/models/objectInstance.ts \
         src/services/funnel/mergeStage.ts \
         src/routes/charts.ts \
         src/services/furnaceSqlService.ts; do
  if grep -qE '\bobject_instances\b' "$f"; then
    pass "$(basename "$f") uses object_instances"
  else
    fail "$(basename "$f") does not reference object_instances"
  fi
done

# ---------------------------------------------------------------------------
# B5 — batched bulkUpsertInstances
# ---------------------------------------------------------------------------
echo
echo "B5  Merge stage — bulkUpsertInstances is batched (no per-row loop)"

# The old path was `for (const r of rows) await upsertInstance(r, pg);` —
# assert that pattern is gone.
if grep -q 'for (const r of rows) {' src/models/objectInstance.ts \
   && grep -q 'await upsertInstance(r, pg);' src/models/objectInstance.ts; then
  fail "N+1 upsert loop still present in bulkUpsertInstances"
else
  pass "no N+1 upsert loop in bulkUpsertInstances"
fi

# And the new path uses a multi-row INSERT + unnest.
if grep -q 'INSERT INTO object_instances' src/models/objectInstance.ts \
   && grep -q 'unnest(' src/models/objectInstance.ts; then
  pass "bulkUpsertInstances uses multi-row INSERT + unnest()"
else
  fail "bulkUpsertInstances is not using a batched insert"
fi

# Chunk size is bounded to stay under Postgres's 65 535 parameter cap.
if grep -q 'BULK_UPSERT_CHUNK_SIZE' src/models/objectInstance.ts; then
  pass "chunk size constant defined (bounds parameter count)"
else
  fail "no chunk-size bound — will hit Postgres's 65k parameter limit"
fi

# ---------------------------------------------------------------------------
# B3 — per-activity timeouts + hydration error surfacing
# ---------------------------------------------------------------------------
echo
echo "B3  Temporal — per-activity timeouts + surfaced Hydration errors"

wf=src/services/funnel/temporal/workflows.ts

# Spec §B3 timeouts: Changelog 1h, Merge 2h, Indexing 4h, Hydration 30m.
declare -a pairs=(
  'runChangelogActivity|1 hour'
  'runMergeActivity|2 hours'
  'runIndexingActivityProxy|4 hours'
  'runHydrationActivityProxy|30 minutes'
)
for pair in "${pairs[@]}"; do
  act="${pair%%|*}"
  timeout="${pair##*|}"
  block=$(awk -v a="$act" '
    /proxyActivities/ {inblock=1; buf=""}
    inblock {buf=buf"\n"$0}
    inblock && /}\)/ {if (buf ~ a) print buf; inblock=0}
  ' "$wf")
  if grep -qF "\"$timeout\"" <<<"$block"; then
    pass "$act has startToCloseTimeout = \"$timeout\""
  else
    fail "$act is missing startToCloseTimeout \"$timeout\" (spec §B3)"
  fi
done

# Retry attempts per stage: Changelog/Merge 5, Indexing 3, Hydration 10.
declare -a attempts=(
  'runChangelogActivity|maximumAttempts: 5'
  'runMergeActivity|maximumAttempts: 5'
  'runIndexingActivityProxy|maximumAttempts: 3'
  'runHydrationActivityProxy|maximumAttempts: 10'
)
for pair in "${attempts[@]}"; do
  act="${pair%%|*}"
  need="${pair##*|}"
  block=$(awk -v a="$act" '
    /proxyActivities/ {inblock=1; buf=""}
    inblock {buf=buf"\n"$0}
    inblock && /}\)/ {if (buf ~ a) print buf; inblock=0}
  ' "$wf")
  if grep -qF "$need" <<<"$block"; then
    pass "$act has '$need'"
  else
    fail "$act missing retry budget '$need' (spec §B3)"
  fi
done

# Hydration errors must propagate — no `try { ... } catch { return 0 }` in
# the hydration proxy.
hy=src/services/funnel/temporal/activities.ts
if awk '/runHydrationActivityProxy\(/,/^}/' "$hy" \
     | grep -qE 'catch\b[^{]*\{[^}]*return[[:space:]]*\{[[:space:]]*prefetched:[[:space:]]*0'; then
  fail "Hydration proxy still swallows errors (silent prefetched:0)"
else
  pass "Hydration proxy surfaces errors so Temporal retry policy applies"
fi

# ---------------------------------------------------------------------------
# Compile + unit test gates
# ---------------------------------------------------------------------------
echo
echo "Compile + unit tests"

if npx tsc --noEmit >/tmp/tsc.log 2>&1; then
  pass "tsc --noEmit (clean)"
else
  fail "tsc --noEmit failed (see /tmp/tsc.log)"
  tail -20 /tmp/tsc.log | sed 's/^/      /'
fi

if npx vitest run tests/funnel/unit >/tmp/vitest.log 2>&1; then
  passed=$(grep -Eo '[0-9]+ passed' /tmp/vitest.log | head -1 || echo 'n/a')
  pass "funnel unit tests green ($passed)"
else
  fail "funnel unit tests failed (see /tmp/vitest.log)"
  tail -30 /tmp/vitest.log | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
printf "%s passed, %s failed\n" "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  exit 1
fi
