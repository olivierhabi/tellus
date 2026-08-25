#!/usr/bin/env bash
set -euo pipefail

CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
API_BASE="${API_BASE:-http://localhost:3000/api/v1}"
OWNER_EMAIL="${OWNER_EMAIL:-cypress@tellus.local}"
OWNER_PASSWORD="${OWNER_PASSWORD:-Password123!}"
VIEWER_EMAIL="${VIEWER_EMAIL:-cypress-viewer@tellus.local}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-Password123!}"

tmp_dir="$(mktemp -d)"
rid=""
owner_token=""
cleanup() {
  if [[ -n "$rid" && -n "$owner_token" ]]; then
    local encoded current_etag
    encoded="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$rid")"
    current_etag="$($CURL_BIN -sS -D "$tmp_dir/cleanup.headers" -o /dev/null \
      -H "Authorization: Bearer $owner_token" \
      "$API_BASE/developer-console/applications/$encoded" >/dev/null 2>&1 && \
      tr -d '\r' < "$tmp_dir/cleanup.headers" | awk 'tolower($1)=="etag:"{print $2}' | tail -1 || true)"
    if [[ -n "$current_etag" ]]; then
      $CURL_BIN -sS -o /dev/null -X DELETE \
        -H "Authorization: Bearer $owner_token" -H "If-Match: $current_etag" \
        "$API_BASE/developer-console/applications/$encoded" || true
    fi
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
json_get() {
  node -e '
    const fs=require("fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const result=process.argv[2].split(".").reduce((v,k)=>v?.[k],value);
    if (result === undefined || result === null) process.exit(2);
    process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
  ' "$1" "$2"
}
login() {
  local email="$1" password="$2" output="$3" status
  status="$($CURL_BIN -sS -o "$output" -w '%{http_code}' -X POST \
    "$API_BASE/auth/_test/login-bypass" \
    -H 'Content-Type: application/json' -H 'X-Tellus-Test-Hook: 1' \
    -d "{\"username\":\"$email\",\"password\":\"$password\"}")"
  [[ "$status" == "200" ]] || fail "login $email returned $status: $(cat "$output")"
  json_get "$output" data.accessToken
}
etag_for() {
  $CURL_BIN -sS -D "$tmp_dir/detail.headers" -o "$tmp_dir/detail.json" \
    -H "Authorization: Bearer $owner_token" \
    "$API_BASE/developer-console/applications/$encoded_rid"
  tr -d '\r' < "$tmp_dir/detail.headers" | awk 'tolower($1)=="etag:"{print $2}' | tail -1
}

health="$($CURL_BIN -sS -o "$tmp_dir/health.json" -w '%{http_code}' "$API_BASE/health")"
[[ "$health" == "200" ]] || fail "API health returned $health"
pass 'API health'

owner_token="$(login "$OWNER_EMAIL" "$OWNER_PASSWORD" "$tmp_dir/owner-login.json")"
viewer_token="$(login "$VIEWER_EMAIL" "$VIEWER_PASSWORD" "$tmp_dir/viewer-login.json")"
pass 'two independent authenticated principals'

name="enterprise-dc-e2e-$(date +%s)-$RANDOM"
idempotency_key="dc-e2e-$(date +%s)-$RANDOM"
create_body="{\"name\":\"$name\",\"description\":\"enterprise registry e2e\",\"clientType\":\"confidential\",\"applicationTypes\":[\"backend-service\"],\"permissionMode\":\"application\",\"redirectUris\":[\"http://localhost:8080/auth/callback\"],\"resourceScopes\":[\"api:use-ontologies-read\"]}"
create_status="$($CURL_BIN -sS -D "$tmp_dir/create.headers" -o "$tmp_dir/create.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $idempotency_key" -d "$create_body")"
[[ "$create_status" == "201" ]] || fail "create returned $create_status: $(cat "$tmp_dir/create.json")"
rid="$(json_get "$tmp_dir/create.json" data.id)"
client_id="$(json_get "$tmp_dir/create.json" data.clientId)"
original_secret="$(json_get "$tmp_dir/create.json" data.clientSecret)"
encoded_rid="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$rid")"
[[ -n "$original_secret" ]] || fail 'create did not return the one-time client secret'
pass 'confidential application provisioned in Keycloak and Postgres'

replay_status="$($CURL_BIN -sS -o "$tmp_dir/replay.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $idempotency_key" -d "$create_body")"
[[ "$replay_status" == "201" ]] || fail "idempotent replay returned $replay_status"
[[ "$(json_get "$tmp_dir/replay.json" data.id)" == "$rid" ]] || fail 'idempotent replay changed RID'
[[ "$(json_get "$tmp_dir/replay.json" data.clientSecret)" == "$original_secret" ]] || fail 'idempotent replay changed encrypted one-time response'
conflict_status="$($CURL_BIN -sS -o "$tmp_dir/conflict.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $idempotency_key" -d "${create_body/enterprise registry e2e/different body}")"
[[ "$conflict_status" == "409" ]] || fail "idempotency conflict returned $conflict_status"
pass 'durable encrypted idempotency replay and conflict detection'

unauthorized_status="$($CURL_BIN -sS -o "$tmp_dir/unauthorized.json" -w '%{http_code}' \
  -H "Authorization: Bearer $viewer_token" \
  "$API_BASE/developer-console/applications/$encoded_rid")"
[[ "$unauthorized_status" == "404" ]] || fail "non-member detail returned $unauthorized_status instead of opaque 404"
pass 'deny-by-default application authorization'

etag="$(etag_for)"
[[ "$etag" =~ ^\"v[0-9]+\"$ ]] || fail "invalid application ETag: $etag"
patch_status="$($CURL_BIN -sS -D "$tmp_dir/patch.headers" -o "$tmp_dir/patch.json" -w '%{http_code}' \
  -X PATCH "$API_BASE/developer-console/applications/$encoded_rid" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "If-Match: $etag" -d '{"description":"optimistic concurrency verified"}')"
[[ "$patch_status" == "200" ]] || fail "ETag patch returned $patch_status: $(cat "$tmp_dir/patch.json")"
stale_status="$($CURL_BIN -sS -o "$tmp_dir/stale.json" -w '%{http_code}' \
  -X PATCH "$API_BASE/developer-console/applications/$encoded_rid" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "If-Match: $etag" -d '{"description":"must not apply"}')"
[[ "$stale_status" == "412" ]] || fail "stale ETag returned $stale_status"
pass 'optimistic concurrency and stale-write rejection'

token_endpoint="${KEYCLOAK_URL:-http://localhost:8086}/realms/${KEYCLOAK_REALM:-tellus}/protocol/openid-connect/token"
old_token_status="$($CURL_BIN -sS -o "$tmp_dir/kc-old-before.json" -w '%{http_code}' \
  -X POST "$token_endpoint" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' --data-urlencode "client_id=$client_id" \
  --data-urlencode "client_secret=$original_secret")"
[[ "$old_token_status" == "200" ]] || fail "original client secret could not obtain a token ($old_token_status)"
etag="$(etag_for)"
rotate_status="$($CURL_BIN -sS -o "$tmp_dir/rotate.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications/$encoded_rid/oauth/rotate-secret" \
  -H "Authorization: Bearer $owner_token" -H "If-Match: $etag")"
[[ "$rotate_status" == "200" ]] || fail "secret rotation returned $rotate_status: $(cat "$tmp_dir/rotate.json")"
new_secret="$(json_get "$tmp_dir/rotate.json" data.clientSecret)"
[[ "$new_secret" != "$original_secret" ]] || fail 'Keycloak rotation returned the old secret'
old_token_status="$($CURL_BIN -sS -o "$tmp_dir/kc-old-after.json" -w '%{http_code}' \
  -X POST "$token_endpoint" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' --data-urlencode "client_id=$client_id" \
  --data-urlencode "client_secret=$original_secret")"
new_token_status="$($CURL_BIN -sS -o "$tmp_dir/kc-new.json" -w '%{http_code}' \
  -X POST "$token_endpoint" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' --data-urlencode "client_id=$client_id" \
  --data-urlencode "client_secret=$new_secret")"
[[ "$old_token_status" == "401" && "$new_token_status" == "200" ]] || \
  fail "secret cutover failed: old=$old_token_status new=$new_token_status"
pass 'real Keycloak secret rotation invalidates the old credential'

catalog_status="$($CURL_BIN -sS -o "$tmp_dir/catalog.json" -w '%{http_code}' \
  -H "Authorization: Bearer $owner_token" "$API_BASE/developer-console/ontology-catalog?pageSize=20")"
[[ "$catalog_status" == "200" ]] || fail "ontology catalog returned $catalog_status"
resource_body="$(node -e '
  const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).data;
  const item=d.objectTypes?.[0]; if(!item) process.exit(2);
  process.stdout.write(JSON.stringify({resources:[{kind:"object_type",apiName:item.apiName,displayName:item.displayName,status:item.status||"active"}]}));
' "$tmp_dir/catalog.json")"
selected_object_type="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).resources[0].apiName)' "$resource_body")"
etag="$(etag_for)"
resource_status="$($CURL_BIN -sS -o "$tmp_dir/resources.json" -w '%{http_code}' \
  -X PUT "$API_BASE/developer-console/applications/$encoded_rid/ontology-sdk/resources" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "If-Match: $etag" -d "$resource_body")"
[[ "$resource_status" == "200" ]] || fail "ontology resource save returned $resource_status: $(cat "$tmp_dir/resources.json")"
unknown_status="$($CURL_BIN -sS -o "$tmp_dir/unknown.json" -w '%{http_code}' \
  -X PUT "$API_BASE/developer-console/applications/$encoded_rid/ontology-sdk/resources" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -H "If-Match: $(etag_for)" \
  -d '{"resources":[{"kind":"object_type","apiName":"DefinitelyUnknownType","displayName":"Unknown"}]}')"
[[ "$unknown_status" == "400" ]] || fail "unknown ontology resource returned $unknown_status"
pass 'Ontology Manager catalog integration and server-side resource validation'

etag="$(etag_for)"
generate_status="$($CURL_BIN -sS -o "$tmp_dir/generate.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications/$encoded_rid/ontology-sdk/versions" \
  -H "Authorization: Bearer $owner_token" -H "If-Match: $etag")"
[[ "$generate_status" == "201" ]] || fail "SDK generation returned $generate_status: $(cat "$tmp_dir/generate.json")"
version="$(node -e '
  const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).data;
  if(!d.versions?.length) process.exit(2); process.stdout.write(d.versions[0].version);
' "$tmp_dir/generate.json")"
registry_status="$($CURL_BIN -sS -o "$tmp_dir/registry.json" -w '%{http_code}' \
  -H "Authorization: Bearer $owner_token" \
  "$API_BASE/developer-console/applications/$encoded_rid/ontology-sdk/registry")"
[[ "$registry_status" == "200" ]] || fail "registry metadata returned $registry_status: $(cat "$tmp_dir/registry.json")"
[[ "$(json_get "$tmp_dir/registry.json" dist-tags.latest)" == "$version" ]] || fail 'registry latest tag is incorrect'
tarball_status="$($CURL_BIN -sS -D "$tmp_dir/tarball.headers" -o "$tmp_dir/sdk.tgz" -w '%{http_code}' \
  -H "Authorization: Bearer $owner_token" \
  "$API_BASE/developer-console/applications/$encoded_rid/ontology-sdk/versions/$version/tarball")"
[[ "$tarball_status" == "200" ]] || fail "artifact download returned $tarball_status"
tar -tzf "$tmp_dir/sdk.tgz" > "$tmp_dir/tar.list"
for artifact_path in package/package.json package/dist/index.js package/dist/index.d.ts package/dist/runtime/client.js package/dist/runtime/client.d.ts package/sbom.cdx.json package/provenance.json; do
  grep -qx "$artifact_path" "$tmp_dir/tar.list" || fail "tarball missing $artifact_path"
done
header_digest="$(tr -d '\r' < "$tmp_dir/tarball.headers" | awk 'tolower($1)=="etag:"{print $2}' | tail -1 | sed -E 's/^"sha256-//;s/"$//')"
actual_digest="$(shasum -a 256 "$tmp_dir/sdk.tgz" | awk '{print $1}')"
[[ "$header_digest" == "$actual_digest" ]] || fail 'downloaded artifact digest does not match immutable registry metadata'
mkdir -p "$tmp_dir/install"
tar -xzf "$tmp_dir/sdk.tgz" -C "$tmp_dir/install"
TOKEN="$owner_token" OBJECT_TYPE="$selected_object_type" SDK_ENTRY="$tmp_dir/install/package/dist/index.js" \
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const sdk = await import(pathToFileURL(process.env.SDK_ENTRY).href);
    if (typeof sdk.createTellusOsdkClient !== "function") throw new Error("generated runtime export missing");
    const client = sdk.createTellusOsdkClient({
      baseUrl: "http://localhost:3000",
      accessToken: process.env.TOKEN,
      retries: 1,
    });
    const result = await client.objects.list(process.env.OBJECT_TYPE, { pageSize: 1 });
    if (!result || typeof result !== "object") throw new Error("runtime object query returned an invalid envelope");
  ' || fail 'installed generated OSDK runtime could not query the live Object API'
pass 'compiled OSDK tarball, installed runtime query, declarations, SBOM, provenance, npm metadata, and digest verification'

metrics_status="$($CURL_BIN -sS -o "$tmp_dir/metrics.json" -w '%{http_code}' \
  -X POST "$API_BASE/developer-console/applications/$encoded_rid/metrics" \
  -H "Authorization: Bearer $owner_token" -H 'Content-Type: application/json' \
  -d '{"points":[{"metric":"requests","value":1,"dimensions":{"source":"enterprise-e2e"}}]}')"
[[ "$metrics_status" == "201" ]] || fail "metric ingest returned $metrics_status"
members_status="$($CURL_BIN -sS -o "$tmp_dir/members.json" -w '%{http_code}' \
  -H "Authorization: Bearer $owner_token" \
  "$API_BASE/developer-console/applications/$encoded_rid/members")"
audit_status="$($CURL_BIN -sS -o "$tmp_dir/audit.json" -w '%{http_code}' \
  -H "Authorization: Bearer $owner_token" \
  "$API_BASE/developer-console/applications/$encoded_rid/audit")"
[[ "$members_status" == "200" && "$audit_status" == "200" ]] || fail "members=$members_status audit=$audit_status"
node -e '
  const fs=require("fs"); const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).data;
  const actions=new Set(rows.map(x=>x.action));
  for(const action of ["application.create","application.update","oauth.secret.rotate","ontology.resources.replace","sdk.artifact.publish"]){
    if(!actions.has(action)){ console.error(`missing audit action ${action}`); process.exit(2); }
  }
' "$tmp_dir/audit.json" || fail 'durable audit trail is incomplete'
pass 'membership control plane, durable audit trail, and metrics ingestion'

echo "ENTERPRISE_DEVELOPER_CONSOLE_E2E: PASS"
