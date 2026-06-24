#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# diagnose-commit-flow.sh
#
# Drives the EXACT same HTTP sequence the IDE's Commit button performs,
# printing every response verbatim so an operator can see which layer
# produces a wrong shape. Targeted at the "Branch main not found in
# repository state" failure mode.
#
# Sequence mirrors `tellus-fe/app/code-repositories/repo/[rid]/page.tsx`
# `handleCommit`:
#   1. GET /:rid                        → defaultBranch
#   2. GET /:rid/branches               → must include defaultBranch with a
#                                          non-empty headSha (a.k.a.
#                                          tipCommitSha after FE normalize)
#   3. POST /:rid/branches/main/commits → real commit attempt
#
# Usage:
#   TELLUS_BASE=http://localhost:3001 \
#   TELLUS_RID=ri.stemma.main.repository.fd8a21dd-... \
#   TELLUS_TOKEN=eyJ... \
#   bash scripts/diagnose-commit-flow.sh
#
# Either TELLUS_TOKEN (production-auth bearer) or
# CODE_REPOS_TEST_AUTH=1 + TELLUS_PRINCIPAL=alice (test bypass)
# must be in effect on the backend.
# ----------------------------------------------------------------------------
set -euo pipefail

BASE="${TELLUS_BASE:-http://localhost:3001}"
RID="${TELLUS_RID:?TELLUS_RID is required - set to the repository RID being committed to}"
TOKEN="${TELLUS_TOKEN:-}"
PRINCIPAL="${TELLUS_PRINCIPAL:-alice}"

# Build the auth headers like the browser does.
AUTH_HEADERS=()
if [[ -n "$TOKEN" ]]; then
  AUTH_HEADERS+=(-H "Authorization: Bearer $TOKEN")
  AUTH_HEADERS+=(-b "TELLUS_TOKEN=$TOKEN")
else
  AUTH_HEADERS+=(-H "X-Tellus-Test-Principal: $PRINCIPAL")
  AUTH_HEADERS+=(-H "X-Tellus-Test-Roles: editor")
fi

bold()    { printf "\033[1m%s\033[0m\n" "$*"; }
green()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()     { printf "\033[31m%s\033[0m\n" "$*"; }
yellow()  { printf "\033[33m%s\033[0m\n" "$*"; }

# Run curl, capture body to /tmp/_diag_body and status code to stdout.
hit() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -X "$method" -H "Accept: application/json" -H "Content-Type: application/json"
              -o /tmp/_diag_body -w "%{http_code}" "${AUTH_HEADERS[@]}")
  [[ -n "$data" ]] && args+=(-d "$data")
  curl "${args[@]}" "${BASE}${path}"
}

bold ""
bold "=================================================================="
bold "  Commit-flow diagnosis — RID = $RID"
bold "  BASE = $BASE"
bold "=================================================================="
bold ""

# ---------------------------------------------------------------------------
# Step 1 — GET /:rid    (the page's repoQ)
# ---------------------------------------------------------------------------
bold "[1/3]  GET /:rid"
code=$(hit GET "/api/v1/code-repositories/$RID")
body=$(cat /tmp/_diag_body)
if [[ "$code" != "200" ]]; then
  red "  FAIL: expected 200, got $code"
  echo "  body:"; echo "$body" | head -10
  exit 1
fi
default_branch=$(echo "$body" | jq -r '.defaultBranch // empty')
if [[ -z "$default_branch" ]]; then
  red "  FAIL: response has no 'defaultBranch' field"
  echo "  body:"; echo "$body" | jq .
  exit 1
fi
green "  ok  defaultBranch = \"$default_branch\""
echo ""

# ---------------------------------------------------------------------------
# Step 2 — GET /:rid/branches   (the page's branchesQ — the source of the bug)
# ---------------------------------------------------------------------------
bold "[2/3]  GET /:rid/branches"
code=$(hit GET "/api/v1/code-repositories/$RID/branches")
body=$(cat /tmp/_diag_body)
if [[ "$code" != "200" ]]; then
  red "  FAIL: expected 200, got $code"
  echo "  body:"; echo "$body" | head -20
  exit 1
fi

# What field name does the backend actually use? This is the wire-shape
# question the frontend mapper depends on.
echo "  raw wire shape (first branch row):"
echo "$body" | jq '.branches[0]' | sed 's/^/    /'
echo ""

# Probe for BOTH possible field names so we know which the backend emits.
wire_name=$(echo "$body" | jq -r '.branches[0].name // empty')
wire_branch_name=$(echo "$body" | jq -r '.branches[0].branchName // empty')
wire_head=$(echo "$body" | jq -r '.branches[0].headSha // empty')
wire_tip=$(echo "$body" | jq -r '.branches[0].tipCommitSha // empty')

if [[ -n "$wire_name" && -z "$wire_branch_name" ]]; then
  green "  ok  backend wire shape: { name, headSha, ... }  (matches normalizer)"
elif [[ -z "$wire_name" && -n "$wire_branch_name" ]]; then
  yellow "  WARN: backend wire shape: { branchName, tipCommitSha, ... }"
  yellow "        (mapper was patched for { name, headSha }; this would silently fail)"
elif [[ -n "$wire_name" && -n "$wire_branch_name" ]]; then
  yellow "  WARN: backend emits BOTH { name, branchName } — mapper picks 'name'"
else
  red "  FAIL: backend emits NEITHER { name } NOR { branchName }"
  echo "$body" | jq '.branches[0]' | sed 's/^/    /'
  exit 1
fi

# Is the defaultBranch present in the list?
present_via_name=$(echo "$body" | jq --arg b "$default_branch" '[.branches[] | select(.name == $b)] | length')
present_via_branchname=$(echo "$body" | jq --arg b "$default_branch" '[.branches[] | select(.branchName == $b)] | length')

if [[ "$present_via_name" -gt 0 || "$present_via_branchname" -gt 0 ]]; then
  green "  ok  defaultBranch \"$default_branch\" is present in /branches list"
else
  red "  FAIL: defaultBranch \"$default_branch\" is NOT in /branches list"
  echo "  Available branch names from backend:"
  echo "$body" | jq -r '.branches[] | (.name // .branchName)' | sed 's/^/    - /'
  echo ""
  red "  This is the real root cause — the cache contains different branches"
  red "  than the repository's stated default_branch. The DB row in"
  red "  code_repository_branch_cache does not have a row for \"$default_branch\"."
  echo ""
  bold "  Recommended fix:"
  echo "    Re-seed the branch cache by hitting the saga's create-or-update path,"
  echo "    or insert directly:"
  echo "      INSERT INTO code_repository_branch_cache (repository_rid, branch_name, head_sha, is_protected, updated_at)"
  echo "      VALUES ('$RID', '$default_branch', '0000000000000000000000000000000000000000', false, NOW())"
  echo "      ON CONFLICT DO NOTHING;"
  exit 2
fi

head_sha="$wire_head"
[[ -z "$head_sha" ]] && head_sha=$(echo "$body" | jq -r --arg b "$default_branch" '[.branches[] | select((.name // .branchName) == $b) | (.headSha // .tipCommitSha)][0] // empty')
if [[ -z "$head_sha" || "$head_sha" == "null" ]]; then
  red "  FAIL: \"$default_branch\" has no headSha/tipCommitSha"
  exit 1
fi
green "  ok  head sha for \"$default_branch\" = $head_sha"
echo ""

# ---------------------------------------------------------------------------
# Step 3 — POST /:rid/branches/:branch/commits   (a real commit attempt)
# ---------------------------------------------------------------------------
bold "[3/3]  POST /:rid/branches/$default_branch/commits"
idem=$(uuidgen | tr 'A-Z' 'a-z')
content=$(printf 'Diagnostic commit at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | base64 | tr -d '\n')
body_in=$(cat <<EOF
{
  "message": "diagnose-commit-flow: round-trip test",
  "fileChanges": [
    { "path": "DIAGNOSTIC.txt", "op": "add", "contentBase64": "$content" }
  ]
}
EOF
)

code=$(curl -sS -X POST \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $idem" \
  -H "If-Match: \"$head_sha\"" \
  "${AUTH_HEADERS[@]}" \
  -o /tmp/_diag_body \
  -w "%{http_code}" \
  -d "$body_in" \
  "${BASE}/api/v1/code-repositories/$RID/branches/$default_branch/commits")
body=$(cat /tmp/_diag_body)

case "$code" in
  201|200)
    green "  ok  commit accepted ($code)"
    new_head=$(echo "$body" | jq -r '.result.newHeadSha // empty')
    green "  ok  new head sha = $new_head"
    ;;
  *)
    red "  FAIL: commit returned $code"
    echo "  body:"; echo "$body" | jq . 2>/dev/null || echo "$body"
    exit 1
    ;;
esac

echo ""
green "All three backend steps passed - commit path is healthy end-to-end."
echo ""

# ---------------------------------------------------------------------------
# Step 4 - Frontend bundle freshness probe
# ---------------------------------------------------------------------------
# If the backend is healthy but the IDE still shows the old toast text,
# the browser is loading a stale frontend bundle. We probe the Next.js
# dev server's compiled page chunk and check which version of the toast
# message it contains. The OLD message was the wire-shape-bug error;
# the NEW message is the diagnostic four-mode handler.
# ---------------------------------------------------------------------------
FE_BASE="${TELLUS_FE_BASE:-http://localhost:3001}"
bold "[4/4]  Frontend bundle freshness probe at $FE_BASE"

# Try the page chunk that Next.js serves for /code-repositories/repo/[rid].
# In dev, the chunk URL is roughly /_next/static/chunks/app/code-repositories/repo/[rid]/page.js
PAGE_URL="$FE_BASE/_next/static/chunks/app/code-repositories/repo/%5Brid%5D/page.js"
http_code=$(curl -sS -o /tmp/_diag_bundle -w "%{http_code}" "$PAGE_URL" 2>/dev/null || echo "000")
if [[ "$http_code" == "200" ]]; then
  bundle_size=$(wc -c < /tmp/_diag_bundle | tr -d ' ')
  old_count=$(grep -c "not found in repository state" /tmp/_diag_bundle 2>/dev/null || echo 0)
  new_count=$(grep -c "not in branches list" /tmp/_diag_bundle 2>/dev/null || echo 0)
  echo "  bundle size:        ${bundle_size} bytes"
  echo "  OLD message count:  $old_count"
  echo "  NEW message count:  $new_count"
  if [[ "$old_count" -gt 0 ]]; then
    red "  FAIL: browser bundle still contains the OLD toast message."
    red "        Run: rm -rf tellus-fe/.next && cd tellus-fe && npm run dev"
    exit 3
  elif [[ "$new_count" -gt 0 ]]; then
    green "  ok  browser bundle has the NEW diagnostic toast (commit path FE-fix is live)"
  else
    yellow "  WARN: bundle has NEITHER message - the chunk URL probed is wrong"
    yellow "        or Next.js code-splits the toast string into a separate chunk."
  fi
else
  yellow "  Could not fetch the page chunk (HTTP $http_code). Skipping bundle probe."
  yellow "  If you DO see the OLD message in the browser, run from the tellus-fe directory:"
  yellow "    rm -rf .next && npm run dev"
fi

echo ""
green "Diagnostic complete."

