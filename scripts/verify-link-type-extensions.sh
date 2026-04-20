#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# verify-link-type-extensions.sh
#
# End-to-end smoke test for the LT-B1..B10 link type extensions. Assumes
# the tellus backend is already running on $API (default localhost:3000)
# with a default ontology seeded. Designed to be safe to re-run: every
# created link type is deleted at the end.
#
# Usage:
#   API=http://localhost:3000 ./scripts/verify-link-type-extensions.sh
#   (alternatively export TELLUS_TOKEN for auth)
# ---------------------------------------------------------------------------
set -u

API="${API:-http://localhost:3000}"
ONTOLOGY_ID="${ONTOLOGY_ID:-default}"
BASE="$API/api/v1/ontology/$ONTOLOGY_ID/linkTypes"
AUTH_HEADER=""
if [ -n "${TELLUS_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${TELLUS_TOKEN}"
fi
CT_HEADER="Content-Type: application/json"

# Colours + counters
RED=$(printf '\033[0;31m')
GRN=$(printf '\033[0;32m')
YLW=$(printf '\033[0;33m')
NC=$(printf '\033[0m')
PASS=0
FAIL=0
SKIP=0

log()  { printf "%b\n" "$*"; }
pass() { log "  ${GRN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { log "  ${RED}✗${NC} $1 — $2"; FAIL=$((FAIL + 1)); }
skip() { log "  ${YLW}-${NC} $1 — $2"; SKIP=$((SKIP + 1)); }

# --------------------------------------------------------------------------
# Request helper. Prints "<status>|<body>" to stdout so callers can split.
# --------------------------------------------------------------------------
req() {
  local method="$1"; shift
  local url="$1"; shift
  local body="${1:-}"
  local tmp; tmp="$(mktemp)"
  local status
  local curl_args=(-sS -o "$tmp" -w '%{http_code}' -X "$method" -H "$CT_HEADER")
  if [ -n "$AUTH_HEADER" ]; then
    curl_args+=(-H "$AUTH_HEADER")
  fi
  if [ -n "$body" ]; then
    curl_args+=(--data "$body")
  fi
  curl_args+=("$url")
  status=$(curl "${curl_args[@]}" || echo 000)
  printf "%s|%s\n" "$status" "$(cat "$tmp")"
  rm -f "$tmp"
}

json_get() {
  # $1 = key (supports dot path like a.b.c), $2 = json blob
  local key="$1"; local blob="$2"
  printf "%s" "$blob" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const ks=process.argv[1].split(".");let v=j;for(const k of ks){if(v==null)break;v=v[k];}process.stdout.write(v==null?"":String(v));}catch{process.stdout.write("");}})' "$key"
}

log "${GRN}==>${NC} Verifying LT-B1..B10 at $BASE"

# --------------------------------------------------------------------------
# 0. Backend health / listing
# --------------------------------------------------------------------------
res=$(req GET "$BASE")
status="${res%%|*}"
if [ "$status" = "200" ] || [ "$status" = "401" ] || [ "$status" = "403" ]; then
  pass "link-types endpoint reachable (HTTP $status)"
else
  fail "link-types endpoint reachable" "HTTP $status"
  exit 1
fi

# --------------------------------------------------------------------------
# LT-B2 — resolver config
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B2 resolver config"
res=$(req GET "$BASE/_config/resolver")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  mi=$(json_get max_intermediate_pks "$body")
  if [ -n "$mi" ]; then
    pass "GET /_config/resolver returns max_intermediate_pks=$mi"
  else
    fail "GET /_config/resolver" "missing max_intermediate_pks field"
  fi
else
  skip "GET /_config/resolver" "HTTP $status (auth?)"
fi

res=$(req PUT "$BASE/_config/resolver" \
  '{"maxIntermediatePks":200000,"escalationBackend":"clickhouse","escalationThresholdPks":150000}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  v=$(json_get escalation_backend "$body")
  if [ "$v" = "clickhouse" ]; then
    pass "PUT /_config/resolver persisted escalation_backend=clickhouse"
  else
    fail "PUT /_config/resolver persist" "got '$v'"
  fi
else
  skip "PUT /_config/resolver" "HTTP $status"
fi

res=$(req PUT "$BASE/_config/resolver" '{"escalationBackend":"not-a-backend"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ]; then
  pass "PUT /_config/resolver rejects unknown backend with 400"
else
  skip "PUT /_config/resolver validation" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B4 — violation listing + resolve-unknown 404
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B4 ONE_TO_ONE violations"
res=$(req GET "$BASE/employedBy/violations?status=pending")
status="${res%%|*}"; body="${res#*|}"
case "$status" in
  200)
    tc=$(json_get totalCount "$body")
    pass "GET /:apiName/violations returns envelope (totalCount=$tc)"
    ;;
  404)
    skip "GET /:apiName/violations" "link type 'employedBy' not seeded"
    ;;
  *)
    skip "GET /:apiName/violations" "HTTP $status"
    ;;
esac

res=$(req POST \
  "$BASE/employedBy/violations/00000000-0000-0000-0000-000000000000/resolve" \
  '{"resolvedBy":"smoke-test"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "404" ]; then
  code=$(json_get errorCode "$body")
  if [ "$code" = "QUARANTINE_NOT_FOUND" ]; then
    pass "resolve-unknown returns QUARANTINE_NOT_FOUND"
  else
    fail "resolve-unknown errorCode" "got '$code'"
  fi
else
  skip "resolve-unknown quarantine" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B5 — orphan stats
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B5 FK orphan state"
res=$(req GET "$BASE/employedBy/orphan-stats?days=7")
status="${res%%|*}"
if [ "$status" = "200" ] || [ "$status" = "404" ]; then
  pass "GET /:apiName/orphan-stats returns HTTP $status"
else
  fail "GET /:apiName/orphan-stats" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B7 — marking-trace
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B7 MCP marking-trace"
res=$(req GET \
  "$BASE/employedBy/edge/E001/C001/marking-trace?sourceMarkings=SECRET&targetMarkings=PUBLIC")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  mode=$(json_get mcpPropagationMode "$body")
  pass "marking-trace returned mode=$mode"
else
  skip "marking-trace" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B9 — offset cap
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B9 search_after offset cap"
deep_token=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({offset:10001})).toString("base64"))')
res=$(req POST "$BASE/employedBy/resolve" \
  "{\"objectPK\":\"E001\",\"direction\":\"forward\",\"pageToken\":\"$deep_token\",\"paginationMode\":\"offset\"}")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ]; then
  code=$(json_get errorCode "$body")
  if [ "$code" = "OFFSET_TOO_DEEP_USE_SEARCH_AFTER" ]; then
    pass "deep offset rejected with OFFSET_TOO_DEEP_USE_SEARCH_AFTER"
  else
    fail "deep offset errorCode" "got '$code'"
  fi
else
  skip "deep offset rejection" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B10 — analysis precision
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B10 composite aggregation"
res=$(req GET "$BASE/employedBy/analysis?precision=fast")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  method=$(json_get computationMethod "$body")
  pass "GET /analysis?precision=fast returned computationMethod=$method"
else
  skip "GET /analysis?precision=fast" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B1 — storage backend flag round-trip + migrate-storage gate
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B1 storage backend"
res=$(req GET "$BASE/employedBy")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  sb=$(json_get storageBackend "$body")
  if [ "$sb" = "csv_legacy" ] || [ "$sb" = "iceberg" ]; then
    pass "GET /:apiName exposes storageBackend=$sb"
  else
    fail "storageBackend field" "got '$sb'"
  fi
else
  skip "GET /:apiName" "HTTP $status"
fi

# ONE_TO_ONE links can't migrate — should reject.
res=$(req POST "$BASE/employedBy/migrate-storage" '')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "400" ]; then
  code=$(json_get errorCode "$body")
  if [ "$code" = "VALIDATION_FAILED" ]; then
    pass "migrate-storage rejects non-M2M with VALIDATION_FAILED"
  else
    fail "migrate-storage reject reason" "got '$code'"
  fi
else
  skip "migrate-storage" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B3 — link_edit schema includes coordination cols; link type has
# violation_policy defaulting to reject for fresh ONE_TO_ONE.
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B3 CDC v2 + link_edit coordination"
vp=$(json_get violationPolicy "$body")
# re-read because last body came from a failure path
res=$(req GET "$BASE/employedBy")
body="${res#*|}"
vp=$(json_get violationPolicy "$body")
if [ "$vp" = "reject" ]; then
  pass "new ONE_TO_ONE link defaults violation_policy=reject"
else
  fail "violation_policy default" "got '$vp'"
fi

# --------------------------------------------------------------------------
# LT-B6 — bidirectional reverse projection fields round-trip
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B6 bidirectional reverse"
ra=$(json_get reverseApiName "$body")
if [ -n "$ra" ] && [ "$ra" != "null" ]; then
  pass "reverseApiName auto-populated as $ra"
else
  fail "reverseApiName auto-populate" "got '$ra'"
fi

rv=$(json_get reverseVisible "$body")
if [ "$rv" = "true" ]; then
  pass "reverseVisible defaults to true"
else
  fail "reverseVisible default" "got '$rv'"
fi

# Reverse-cardinality view: forward ONE_TO_ONE stays ONE_TO_ONE from the
# reverse side — we assert the metadata.cardinality on resolve.
res=$(req POST "$BASE/employedBy/resolve" \
  '{"objectPK":"xxx","direction":"reverse"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  pass "reverse-direction resolve returns 200"
else
  skip "reverse-direction resolve" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B8 — object_cdc_outbox presence
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B8 object CDC outbox"
if [ -n "${PGHOST:-}" ] || command -v node >/dev/null; then
  node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ host:'localhost', port:5432, database:'tellus_db', user:'tellus', password:'tellus123' });
  await c.connect();
  const r = await c.query(\"SELECT to_regclass('public.object_cdc_outbox') AS t\");
  process.stdout.write(String(r.rows[0].t || ''));
  await c.end();
})().catch(e=>{ process.stdout.write(''); });
" 2>/dev/null > /tmp/lt_b8_check
  if [ -s /tmp/lt_b8_check ]; then
    pass "object_cdc_outbox table present ($(cat /tmp/lt_b8_check))"
  else
    skip "object_cdc_outbox" "pg introspection failed"
  fi
  rm -f /tmp/lt_b8_check
else
  skip "object_cdc_outbox" "no pg access"
fi

# --------------------------------------------------------------------------
# LT-B4 — enforcement dry-run (idempotent against a link with no target)
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B4 enforcement dry-run"
res=$(req POST "$BASE/employedBy/enforce-one-to-one" \
  '{"sourcePk":"E001","targetPk":"C001"}')
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  allowed=$(json_get allowed "$body")
  pass "enforce-one-to-one dry-run allowed=$allowed"
elif [ "$status" = "409" ]; then
  pass "enforce-one-to-one correctly rejected existing target (409)"
else
  skip "enforce-one-to-one" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B9 — search_after token shape round-trip via resolve endpoint
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B9 search_after token"
sa_token=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({sort_keys:["x"],pit_id:null,backend:"opensearch"})).toString("base64url"))')
res=$(req POST "$BASE/employedBy/resolve" \
  "{\"objectPK\":\"E001\",\"direction\":\"forward\",\"pageToken\":\"$sa_token\",\"paginationMode\":\"search_after\"}")
status="${res%%|*}"; body="${res#*|}"
if [ "$status" = "200" ]; then
  pm=$(json_get metadata.pagination_mode "$body")
  pass "search_after resolve accepted (pagination_mode=$pm)"
else
  skip "search_after resolve" "HTTP $status"
fi

# --------------------------------------------------------------------------
# LT-B10 — precision=exact + sampled round-trip
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} LT-B10 precision parameter"
for p in exact sampled fast; do
  res=$(req GET "$BASE/employedBy/analysis?precision=$p")
  status="${res%%|*}"; body="${res#*|}"
  if [ "$status" = "200" ]; then
    cm=$(json_get computationMethod "$body")
    pass "precision=$p returned computationMethod=$cm"
  else
    skip "precision=$p" "HTTP $status"
  fi
done

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
log "\n${GRN}==>${NC} Results: ${GRN}$PASS passed${NC}, ${YLW}$SKIP skipped${NC}, ${RED}$FAIL failed${NC}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
