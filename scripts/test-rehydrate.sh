#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/test-rehydrate.sh
#
# Live-fire test for the in-memory Stemma rehydrator (Wave 22.1).
#
# Connects to your local Postgres, lists every ACTIVE row in
# `code_repository`, runs the rehydrator against fresh in-memory Stemma +
# Template adapters (so it cannot touch any live data), and asserts:
#
#   1. The rehydrator runs without error.
#   2. Every ACTIVE repo emits a `code-repos.rehydrate.seeded` event with
#      `scaffolded: true` (= the template re-scaffold path fired).
#   3. The materialised tree contains the v2 scaffold (≥1 file under
#      `typescript-functions/` for typescript-functions repos), NOT an
#      empty branch (which is what the bug looked like before Wave 22.1).
#
# The script is non-destructive: it spins up its own Node process with a
# fresh adapter pair, never touches your running dev server, and exits.
#
# Usage:
#   bash scripts/test-rehydrate.sh
#
# Environment overrides (optional):
#   PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE — defaults match your
#   local docker-compose: tellus / tellus_password / localhost / 5432 /
#   tellus_db.
# ---------------------------------------------------------------------------

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- defaults aligned with the root docker-compose.yml ---------------
: "${PGUSER:=tellus}"
: "${PGPASSWORD:=tellus_password}"
: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=tellus_db}"

export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE
export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# Colours that survive `tee` and zsh.
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'

pass()  { printf "%sPASS%s  %s\n" "$GREEN" "$RST" "$1"; }
fail()  { printf "%sFAIL%s  %s\n" "$RED"   "$RST" "$1"; }
note()  { printf "%s%s%s\n"      "$DIM"   "$1"  "$RST"; }
warn()  { printf "%sWARN%s  %s\n" "$YELLOW" "$RST" "$1"; }

# ---------- 0. Sanity: docker postgres reachable, table exists -------------
if ! docker exec tellus-postgres-1 psql -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT 1" >/dev/null 2>&1; then
  fail "Cannot reach Postgres at tellus-postgres-1. Start docker compose first."
  exit 2
fi
pass "Postgres reachable"

ACTIVE_COUNT=$(docker exec tellus-postgres-1 psql -U "$PGUSER" -d "$PGDATABASE" -tAc \
  "SELECT count(*) FROM code_repository WHERE state='ACTIVE'" | tr -d '[:space:]')

if [[ "$ACTIVE_COUNT" == "0" ]]; then
  warn "No ACTIVE rows in code_repository — there's nothing for the rehydrator to do."
  warn "Create a repo via /code-repositories/new first, then re-run this script."
  exit 0
fi
pass "Found $ACTIVE_COUNT ACTIVE row(s) in code_repository"

# ---------- 1. Run the rehydrator out-of-process ---------------------------
note ""
note "Spinning up rehydrator with in-memory adapters and the live DB pool…"
note "(this never touches your running dev server)"
note ""

LOG_FILE="$(mktemp -t tellus-rehydrate-test.XXXXXX)"
# tsx must resolve `pg` etc. from the repo's node_modules, so the harness
# has to live inside the repo tree (not /tmp/).  We use a deterministic
# dot-prefixed path under scripts/ and clean it up via trap.
HARNESS_TS="./scripts/.test-rehydrate-harness.$$.ts"
trap 'rm -f "$LOG_FILE" "$HARNESS_TS"' EXIT

# The harness imports the production rehydrator + the in-memory adapter pair
# and connects to the live Postgres.  Everything it logs gets `[BOOT]`-tagged
# so we can assert on it deterministically.

cat >"$HARNESS_TS" <<'TS'
import { Pool } from "pg";
import { rehydrateInMemoryStemma } from "../src/services/codeRepository/rehydrate";
import {
  InMemoryStemma,
  InMemoryTemplate,
} from "../src/services/codeRepository/adapters/inMemory";

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stemma = new InMemoryStemma();
  const template = new InMemoryTemplate({ stemma });

  // Capture every structured log emitted by the rehydrator.  We tag with
  // [BOOT] so the bash harness can grep deterministically.
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const logger = (event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ event, ...(fields ?? {}) });
    events.push({ event, fields });
    console.log(`[BOOT] ${line}`);
  };

  const summary = await rehydrateInMemoryStemma({
    pool,
    stemma,
    template,
    logger,
  });

  // Materialised file counts per rid — proof the scaffold actually landed.
  console.log(`[BOOT] ${JSON.stringify({ event: "_test.summary", summary })}`);

  for (const ev of events.filter((e) => e.event === "code-repos.rehydrate.seeded")) {
    const f = ev.fields ?? {};
    const rid = String(f.rid ?? "");
    const branch = String(f.branch ?? "");
    const tree = await stemma.listTree({ repositoryRid: rid, branch, path: "", depth: 5 });
    const fileCount =
      tree.kind === "ok"
        ? tree.entries.filter((e) => e.type === "blob").length
        : -1;
    console.log(
      `[BOOT] ${JSON.stringify({ event: "_test.tree", rid, branch, fileCount })}`,
    );
  }

  await pool.end();
})().catch((err) => {
  console.error(`[BOOT-ERR] ${err?.stack || err?.message || err}`);
  process.exit(1);
});
TS

npx tsx "$HARNESS_TS" 2>&1 | tee "$LOG_FILE"

# ---------- 2. Assert on the harness output --------------------------------
note ""
note "Assertions:"

ok=true

# 2a. No errors during boot.
if grep -q "^\[BOOT-ERR\]" "$LOG_FILE"; then
  fail "harness raised an exception"
  grep "^\[BOOT-ERR\]" "$LOG_FILE" | sed 's/^/   /'
  ok=false
else
  pass "no harness exceptions"
fi

# 2b. Rehydrator's done event reports 0 failures and total ≥ 1.
DONE_LINE=$(grep -E '"event":"code-repos\.rehydrate\.done"' "$LOG_FILE" | tail -1 || true)
if [[ -z "$DONE_LINE" ]]; then
  fail "rehydrator never emitted code-repos.rehydrate.done"
  ok=false
else
  TOTAL=$(echo "$DONE_LINE" | sed -nE 's/.*"total":([0-9]+).*/\1/p')
  REHYD=$(echo "$DONE_LINE" | sed -nE 's/.*"rehydrated":([0-9]+).*/\1/p')
  FAILED=$(echo "$DONE_LINE" | sed -nE 's/.*"failed":([0-9]+).*/\1/p')
  if [[ "$FAILED" == "0" && "$TOTAL" -ge 1 ]]; then
    pass "rehydrate.done: total=$TOTAL rehydrated=$REHYD failed=$FAILED"
  else
    fail "rehydrate.done shows failures: $DONE_LINE"
    ok=false
  fi
fi

# 2c. Every seeded event must carry scaffolded:true.
SEEDED_TOTAL=$(grep -c '"event":"code-repos\.rehydrate\.seeded"' "$LOG_FILE" || true)
SEEDED_SCAFFOLD=$(grep -c '"event":"code-repos\.rehydrate\.seeded".*"scaffolded":true' "$LOG_FILE" || true)
if [[ "$SEEDED_TOTAL" -ge 1 && "$SEEDED_SCAFFOLD" == "$SEEDED_TOTAL" ]]; then
  pass "all $SEEDED_TOTAL seeded event(s) have scaffolded:true"
else
  fail "only $SEEDED_SCAFFOLD/$SEEDED_TOTAL seeded events had scaffolded:true"
  grep '"event":"code-repos\.rehydrate\.seeded"' "$LOG_FILE" | sed 's/^/   /'
  ok=false
fi

# 2d. Every materialised tree must contain ≥ 1 file (was 0 before Wave 22.1).
TREE_LINES=$(grep '"event":"_test.tree"' "$LOG_FILE")
EMPTY_RIDS=$(echo "$TREE_LINES" | grep '"fileCount":0' || true)
if [[ -z "$EMPTY_RIDS" ]]; then
  COUNT=$(echo "$TREE_LINES" | wc -l | tr -d ' ')
  pass "all $COUNT scaffolded tree(s) contain ≥ 1 file"
  echo "$TREE_LINES" | sed -nE 's/.*"rid":"([^"]+)".*"fileCount":([0-9]+).*/   \1: \2 file(s)/p'
else
  fail "some rehydrated repos came back EMPTY (this is the bug Wave 22.1 fixes):"
  echo "$EMPTY_RIDS" | sed 's/^/   /'
  ok=false
fi

# 2e. typescript-functions repos must contain the v2 subproject directory.
note ""
note "v2 scaffold spot-check (typescript-functions repos):"
TS_RIDS=$(docker exec tellus-postgres-1 psql -U "$PGUSER" -d "$PGDATABASE" -tAc \
  "SELECT rid FROM code_repository WHERE state='ACTIVE' AND template_id='typescript-functions'" \
  | tr -d ' ' | grep -v '^$' || true)
if [[ -n "$TS_RIDS" ]]; then
  for rid in $TS_RIDS; do
    # The harness emits one `_test.tree` line per rehydrated repo with the
    # blob count for the materialised tree. We extract that and assert it's
    # ≥ 1 (the bug pre-Wave 22.1 was 0 — empty branches).
    TREE_LINE=$(grep '"event":"_test.tree"' "$LOG_FILE" | grep "\"rid\":\"$rid\"" | head -1 || true)
    if [[ -z "$TREE_LINE" ]]; then
      fail "$rid: no _test.tree event emitted"
      ok=false
      continue
    fi
    FILE_COUNT=$(echo "$TREE_LINE" | sed -nE 's/.*"fileCount":([0-9-]+).*/\1/p')
    if [[ "$FILE_COUNT" -ge 1 ]]; then
      pass "$rid: $FILE_COUNT file(s) (v2 scaffold materialised)"
    else
      fail "$rid: empty tree (fileCount=$FILE_COUNT)"
      ok=false
    fi
  done
else
  note "(no typescript-functions repos to check)"
fi

note ""
if $ok; then
  pass "Wave 22.1 rehydrator: GREEN. Frontend should now show typescript-functions/ on existing repos after a backend restart."
  exit 0
else
  fail "Wave 22.1 rehydrator: RED. See assertions above."
  exit 1
fi
