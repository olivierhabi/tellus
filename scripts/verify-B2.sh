#!/usr/bin/env bash
# verify-B2.sh — Files & Projects B2 (Spaces & Hierarchy Refactor).
#
# Spec:      tasks/files-projects/files-projects-tasks.md:140-200
# Contracts: tasks/files-projects/contracts.md (B2-C-01..B2-C-05, B2-C-30..32, B2-X-01..02).
#
# Runs against the Docker test stack stood up by foundryMigrate.
# Exits 0 on full pass, non-zero with a clear message on failure.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-tellus}"
PGPASSWORD="${PGPASSWORD:-tellus123}"
PGDATABASE="${PGDATABASE:-tellus_db}"
export PGPASSWORD

PSQL=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -tA -v ON_ERROR_STOP=1)

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
fail()  { red   "FAIL: $*"; exit 1; }
ok()    { green "ok:   $*"; }
note()  { yellow "note: $*"; }

ROOT_SPACE_RID="ri.compass.main.space.00000000-0000-0000-0000-000000000000"

# ---------------------------------------------------------------------------
# 1. Schema — B2-C-01
# ---------------------------------------------------------------------------
note "[1/6] spaces table + columns"
have=$("${PSQL[@]}" -c "SELECT to_regclass('public.spaces') IS NOT NULL")
[ "$have" = "t" ] || fail "spaces table missing"
ok "spaces table exists"

required=(rid display_name enrollment_rid default_role_set_id file_system_id usage_account_rid is_root created_at)
for c in "${required[@]}"; do
  exists=$("${PSQL[@]}" -c "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='spaces' AND column_name='$c')")
  [ "$exists" = "t" ] || fail "spaces.$c missing"
done
ok "all required columns present"

# ---------------------------------------------------------------------------
# 2. Partial unique index — B2-C-02
# ---------------------------------------------------------------------------
note "[2/6] spaces_one_root_idx partial unique index"
def=$("${PSQL[@]}" -c "SELECT indexdef FROM pg_indexes WHERE indexname='spaces_one_root_idx'")
[ -n "$def" ] || fail "spaces_one_root_idx missing"
echo "$def" | grep -qi "UNIQUE INDEX" || fail "spaces_one_root_idx not UNIQUE"
echo "$def" | grep -qi "WHERE.*is_root" || fail "spaces_one_root_idx not partial"
ok "spaces_one_root_idx is UNIQUE + partial"

# ---------------------------------------------------------------------------
# 3. Root space row — B2-C-03 / B2-C-04
# ---------------------------------------------------------------------------
note "[3/6] root space row present"
n=$("${PSQL[@]}" -c "SELECT count(*) FROM spaces WHERE rid='$ROOT_SPACE_RID' AND is_root=true")
[ "$n" = "1" ] || fail "root space row missing or is_root!=true ($n found)"
ok "root space row present, is_root=true"

# Exactly one is_root row (B2-C-02 negative-side).
total_root=$("${PSQL[@]}" -c "SELECT count(*) FROM spaces WHERE is_root=true")
[ "$total_root" = "1" ] || fail "more than one is_root=true row found ($total_root)"
ok "exactly one is_root=true row exists"

# B2-C-04 — FK from spaces.rid → resources.rid is satisfied for every row.
orphans=$("${PSQL[@]}" -c "SELECT count(*) FROM spaces s LEFT JOIN resources r ON r.rid = s.rid WHERE r.rid IS NULL")
[ "$orphans" = "0" ] || fail "spaces FK orphans: $orphans"
ok "spaces.rid FK to resources.rid satisfied for every row"

# ---------------------------------------------------------------------------
# 4. Migrate idempotency on B2 — B2-C-03 idempotent (re-run produces no change)
# ---------------------------------------------------------------------------
note "[4/6] migrate idempotency on B2"
before=$("${PSQL[@]}" -c "SELECT count(*) FROM spaces")
PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" PGDATABASE="$PGDATABASE" \
  npm run migrate:foundry --silent >/dev/null 2>&1 || true
after=$("${PSQL[@]}" -c "SELECT count(*) FROM spaces")
[ "$before" = "$after" ] || fail "spaces row count changed across re-migrate ($before → $after)"
ok "migrate is idempotent on spaces ($after rows unchanged)"

# ---------------------------------------------------------------------------
# 5. B1-C-15 not regressed — B2-X-02
# ---------------------------------------------------------------------------
note "[5/6] B1-C-15 not regressed (root self-referential)"
sr=$("${PSQL[@]}" -c "SELECT space_rid FROM resources WHERE rid='$ROOT_SPACE_RID'")
[ "$sr" = "$ROOT_SPACE_RID" ] || fail "resources.space_rid for root no longer self-references ($sr)"
ok "root resources row remains self-referential"

# ---------------------------------------------------------------------------
# 6. No B2-domain files under src/migrations/ — B2-X-01
# ---------------------------------------------------------------------------
note "[6/6] no B2-domain migrations introduced"
if [ -d src/migrations ]; then
  b2_migs=$(ls src/migrations 2>/dev/null \
    | grep -Ei '(^b2[_-]|spaces[_-]|space[_-]hierarchy)' \
    || true)
  if [ -n "$b2_migs" ]; then
    red "B2-X-01 violation:"
    printf '%s\n' "$b2_migs" >&2
    fail "use src/foundryMigrate.ts instead"
  fi
fi
ok "no B2-domain files under src/migrations/"

green ""
green "verify-B2.sh: PASS"
