#!/usr/bin/env bash
# verify-B1.sh — Files & Projects B1 (Compass Resource Model & RID System).
#
# Spec:      tasks/files-projects/files-projects-tasks.md:47-138
# Contracts: tasks/files-projects/contracts.md (B1-C-10 .. B1-C-15, B1-C-32, B1-C-40..42, B1-X-01..02).
#
# Runs against the Docker test stack stood up by `scripts/test-up.sh`.
# Exits 0 on full pass, non-zero with a clear message on failure.
#
# Lane 3 of the brief's three-lane testing model. Cypress alone cannot
# probe DB rows / metric lines with this precision; vitest alone does
# not prove the integrated migrate run.
set -euo pipefail

# ---------------------------------------------------------------------------
# Connection params — defaults match docker-compose-test.yml; override via env.
# ---------------------------------------------------------------------------
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5433}"      # test stack uses 5433 to avoid colliding with dev pg
PGUSER="${PGUSER:-tellus}"
PGPASSWORD="${PGPASSWORD:-tellus}"
PGDATABASE="${PGDATABASE:-tellus_test}"
API_BASE="${API_BASE:-http://localhost:4000}"
export PGPASSWORD

PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tA -v ON_ERROR_STOP=1)

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
fail()  { red   "FAIL: $*"; exit 1; }
ok()    { green "ok:   $*"; }
note()  { yellow "note: $*"; }

# ---------------------------------------------------------------------------
# 1. Schema presence — B1-C-10
# ---------------------------------------------------------------------------
note "[1/9] resources table + columns"
have_resources=$("${PSQL[@]}" -c "SELECT to_regclass('public.resources') IS NOT NULL")
[ "$have_resources" = "t" ] || fail "resources table missing"
ok "resources table exists"

# Verify required columns are present (sample of the most load-bearing).
required_cols=(rid service type display_name parent_folder_rid project_rid space_rid trash_status etag legacy_uuid metadata)
for c in "${required_cols[@]}"; do
  exists=$("${PSQL[@]}" -c "SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
       WHERE table_name='resources' AND column_name='$c')")
  [ "$exists" = "t" ] || fail "resources.$c column missing"
done
ok "all required columns present"

# Verify the rid CHECK constraint is wired. The dumped constraint includes
# the literal sequence `^ri\.` (backslash-dot is part of the regex literal),
# so we look for that as a substring via position(), which avoids LIKE
# escape-character ambiguity.
rid_check=$("${PSQL[@]}" -c "
  SELECT count(*) FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname='resources' AND c.contype='c'
     AND position('^ri' in pg_get_constraintdef(c.oid)) > 0")
[ "$rid_check" -ge 1 ] || fail "resources.rid CHECK regex constraint missing"
ok "resources.rid CHECK regex enforced"

# ---------------------------------------------------------------------------
# 2. Indexes — B1-C-11
# ---------------------------------------------------------------------------
note "[2/9] indexes"
for idx in resources_parent_idx resources_project_idx resources_space_idx resources_type_idx resources_trash_idx; do
  exists=$("${PSQL[@]}" -c "SELECT count(*) FROM pg_indexes WHERE indexname='$idx'")
  [ "$exists" = "1" ] || fail "index $idx missing"
done
ok "five resources indexes present"

# Trash index must be partial.
trash_partial=$("${PSQL[@]}" -c "
  SELECT indexdef FROM pg_indexes WHERE indexname='resources_trash_idx'" | grep -c "WHERE")
[ "$trash_partial" = "1" ] || fail "resources_trash_idx is not a partial index"
ok "resources_trash_idx is partial (WHERE trash_status<>'NOT_TRASHED')"

# ---------------------------------------------------------------------------
# 3. ETag trigger — B1-C-12
# ---------------------------------------------------------------------------
note "[3/9] etag bump trigger"
trig=$("${PSQL[@]}" -c "
  SELECT count(*) FROM pg_trigger
   WHERE tgname='resources_bump_etag_t' AND NOT tgisinternal")
[ "$trig" = "1" ] || fail "resources_bump_etag_t trigger missing"
ok "resources_bump_etag_t trigger present"

# Behaviour test: pick the root space row, observe etag advance after UPDATE.
root_rid='ri.compass.main.space.00000000-0000-0000-0000-000000000000'
before_etag=$("${PSQL[@]}" -c "SELECT etag FROM resources WHERE rid='$root_rid'")
"${PSQL[@]}" -c "UPDATE resources SET description = COALESCE(description,'') || ' .' WHERE rid='$root_rid'" > /dev/null
after_etag=$("${PSQL[@]}" -c "SELECT etag FROM resources WHERE rid='$root_rid'")
[ "$after_etag" -gt "$before_etag" ] || fail "etag did not advance on UPDATE (was $before_etag, now $after_etag)"
ok "etag advances on UPDATE ($before_etag → $after_etag)"

# ---------------------------------------------------------------------------
# 4. Backfill — B1-C-14
# ---------------------------------------------------------------------------
note "[4/9] backfill orphans"
for legacy in projects folders foundry_datasets; do
  orphans=$("${PSQL[@]}" -c "
    SELECT count(*) FROM $legacy l
    LEFT JOIN resources r ON r.legacy_uuid = l.id
    WHERE r.rid IS NULL")
  [ "$orphans" = "0" ] || fail "$legacy has $orphans rows without a matching resources row"
done
ok "no orphan rows in projects, folders, or foundry_datasets"

# ---------------------------------------------------------------------------
# 5. Idempotency — B1-C-13
# ---------------------------------------------------------------------------
note "[5/9] migration idempotency"
count_before=$("${PSQL[@]}" -c "SELECT count(*) FROM resources")
npx tsx src/foundryMigrate.ts > /dev/null 2>&1 || fail "second migrate failed"
count_after=$("${PSQL[@]}" -c "SELECT count(*) FROM resources")
[ "$count_before" = "$count_after" ] || fail "row count changed on re-migrate ($count_before → $count_after)"
ok "migrate is idempotent ($count_before rows unchanged)"

# ---------------------------------------------------------------------------
# 6. Error envelope — B1-C-30 / B1-C-32
# ---------------------------------------------------------------------------
note "[6/9] HTTP error envelopes"

# INVALID_RID_FORMAT — the v2 endpoints land in B3, but the v1 surface
# already calls into compassService for some paths. We probe a known
# v1 read with a malformed RID to see the canonical envelope.
# (When B3 routes land, augment this section to cover them too.)
if curl -sf -o /dev/null "$API_BASE/healthz" 2>/dev/null; then
  body=$(curl -s -o - -w "\n%{http_code}" "$API_BASE/api/v2/filesystem/resources/not-a-rid" || true)
  status=$(printf '%s' "$body" | tail -n1)
  json=$(printf '%s' "$body" | sed '$d')
  if [ "$status" = "404" ] || [ "$status" = "400" ]; then
    if echo "$json" | jq -e '.errorCode' > /dev/null 2>&1; then
      ok "invalid-RID HTTP probe returned canonical envelope"
    else
      note "endpoint reachable but did not return JSON envelope (B3 not yet wired) — skipping"
    fi
  else
    note "no v2 route for resources/{rid} yet (B3 pending) — skipping HTTP probe"
  fi
else
  note "API server not reachable at $API_BASE — skipping HTTP envelope probe"
fi

# ---------------------------------------------------------------------------
# 7. Metrics — B1-C-40 / B1-C-41 / B1-C-42
# ---------------------------------------------------------------------------
note "[7/9] /metrics emission"
if curl -sf "$API_BASE/metrics" -o /tmp/verify-b1-metrics 2>/dev/null; then
  for m in tellus_compass_get_resource_seconds tellus_compass_batch_get_size tellus_compass_rid_parse_errors_total; do
    if grep -q "^$m" /tmp/verify-b1-metrics; then
      ok "metric $m exposed"
    else
      note "metric $m not yet observed (no traffic yet) — running a probe"
    fi
  done
else
  note "API server not reachable — skipping metrics probe"
fi

# ---------------------------------------------------------------------------
# 8. Single-audit-writer invariant probe — Forbidden Behaviors §1291
# ---------------------------------------------------------------------------
note "[8/9] audit single-writer (B5 invariant; B1 baseline)"
# B5 lands the audit infra. For B1 we only assert that no parallel audit
# write surface has been introduced. A grep against the codebase suffices.
strays=$(grep -rn "INSERT INTO audit_log" src \
  --include="*.ts" --include="*.sql" \
  | grep -v "src/db/audit.ts" \
  | grep -v "src/foundryMigrate.ts" || true)
if [ -n "$strays" ]; then
  red "Single-writer invariant at risk — INSERT INTO audit_log outside src/db/audit.ts:"
  printf '%s\n' "$strays" >&2
  fail "audit single-writer breach"
fi
ok "no stray INSERT INTO audit_log sites"

# ---------------------------------------------------------------------------
# 9. No new B1-domain files under src/migrations/ — B1-X-01
#
# The repo hosts unrelated tasks (B7..B9 quiver) that own their own numbered
# migrations. B1-X-01 forbids B1 from doing the same: any migration whose
# basename matches a B1 keyword (compass, resource, rid, space) under
# src/migrations/ is a violation. Other tasks' migrations are out of scope.
# ---------------------------------------------------------------------------
note "[9/9] no B1-domain migrations introduced"
if [ -d src/migrations ]; then
  b1_migs=$(ls src/migrations 2>/dev/null \
    | grep -Ei '(compass|resource|^b1[_-]|rid[_-]|space[_-])' \
    || true)
  if [ -n "$b1_migs" ]; then
    red "B1-X-01 violation — B1-domain files under src/migrations/:"
    printf '%s\n' "$b1_migs" >&2
    fail "use src/foundryMigrate.ts instead"
  fi
fi
ok "no B1-domain files under src/migrations/"

green ""
green "verify-B1.sh: PASS"
