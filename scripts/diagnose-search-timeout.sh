#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# diagnose-search-timeout.sh — pinpoint why
#   POST /api/v1/objects/OlivierOrderJune/search
# returns 504 (REQUEST_TIMEOUT, 5000ms budget).
#
# Walks the chain the backend walks: OpenSearch cluster → index existence →
# direct OS query latency → backend endpoint latency → backend logs.
# Prints a verdict at the end.
# ---------------------------------------------------------------------------
set -u

OS_URL="${OPENSEARCH_URL:-http://localhost:9200}"
BE_URL="${TELLUS_URL:-http://localhost:3000}"
OT="OlivierOrderJune"
INDEX="ontology-$(echo "$OT" | tr '[:upper:]' '[:lower:]')"

# Pull a live bearer token from the cookie the browser uses (TELLUS_TOKEN),
# else fall back to a file. Keeps the script runnable without hardcoding JWTs.
TOKEN="${TELLUS_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "${HOME}/.tellus-token" ]; then TOKEN="$(cat "${HOME}/.tellus-token")"; fi

c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say() { printf '\n%s== %s%s\n' "$c_dim" "$*" "$c_off"; }

say "1. OpenSearch cluster health ($OS_URL)"
health=$(curl -sS -m 5 "$OS_URL/_cluster/health" 2>/dev/null) || true
if [ -z "$health" ]; then
  echo "${c_bad}OPENSEARCH UNREACHABLE on $OS_URL — is the container up?${c_off}"
  echo "  -> docker compose ps opensearch"
else
  echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
fi

say "2. Index existence: $INDEX"
idx=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$OS_URL/$INDEX" 2>/dev/null) || idx="000"
if [ "$idx" = "200" ]; then
  echo "${c_ok}index exists (200)${c_off}"
  cnt=$(curl -sS -m 5 "$OS_URL/$INDEX/_count" 2>/dev/null)
  echo "  doc count: $cnt"
elif [ "$idx" = "404" ]; then
  echo "${c_bad}index MISSING (404) — backend executeSearch treats 404 as empty (fast), so this is NOT a 504 cause on its own.${c_off}"
  echo "  listing indices that look like ontology-*:"
  curl -sS -m 5 "$OS_URL/_cat/indices/ontology-*?h=index,docs.count,store.size,health" 2>/dev/null || true
else
  echo "${c_bad}index lookup returned HTTP $idx${c_off}"
fi

say "3. Direct OpenSearch query latency (what the backend builds)"
q='{"size":51,"query":{"match_all":{}},"sort":[{"__pk":{"order":"asc"}}],"track_total_hits":true}'
t0=$(python3 -c 'import time;print(time.time())')
direct=$(curl -sS -m 15 -w '\n__HTTP %{http_code} __%{time_total}s' \
  -H 'Content-Type: application/json' \
  -X POST "$OS_URL/$INDEX/_search" --data "$q" 2>/dev/null) || direct="(curl failed)"
echo "$direct" | tail -3

say "4. Backend endpoint latency"
if [ -z "$TOKEN" ]; then
  echo "${c_dim}no TELLUS_TOKEN env var — skipping authenticated backend call.${c_off}"
  echo "  set TELLUS_TOKEN=<jwt> to also hit /api/v1/objects/$OT/search"
else
  be=$(curl -sS -m 15 -w '\n__HTTP %{http_code} __%{time_total}s' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -X POST "$BE_URL/api/v1/objects/$OT/search" --data '{"$pageSize":50}' 2>/dev/null) || be="(curl failed)"
  echo "$be" | tail -4
fi

say "5. Recent backend log lines mentioning OpenSearch / search / timeout"
log=$(ls -t .dev-backend-restart.log logs/*.log 2>/dev/null | head -1)
if [ -n "$log" ]; then
  grep -iE "opensearch|\[SEARCH\]|RequestTimeout|REQUEST_TIMEOUT|TimeoutError|ConnectionError|504" "$log" 2>/dev/null | tail -15 || echo "(no matches in $log)"
else
  echo "(no log file found)"
fi

say "Verdict"
if [ -z "$health" ]; then
  echo "${c_bad}OpenSearch is unreachable. The backend's client.search() waits up to 5s then throws -> the 5s request budget fires 504. Start OpenSearch (docker compose up opensearch) and reindex.${c_off}"
elif [ "$idx" = "404" ]; then
  echo "${c_bad}Index $INDEX does not exist. The 404 path returns empty FAST, so a 504 here means something ELSE is slow — check resolveAllProperties (PG) or auth/branch middleware. Inspect section 5 logs.${c_off}"
else
  echo "OpenSearch is reachable and the index exists. Compare direct OS latency (step 3) vs backend latency (step 4). If OS is fast but the backend 504s, the cost is in the backend (PG resolveAllProperties, auth, or head-of-line blocking from the sync function sandbox). If OS itself is slow, the index/query needs tuning."
fi
echo
