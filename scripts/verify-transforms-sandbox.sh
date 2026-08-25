#!/usr/bin/env bash
# ============================================================================
# verify-transforms-sandbox.sh — Gap 3: sandboxed/containerized execution proof
# ============================================================================
#
# Run against a backend started with TELLUS_TRANSFORM_EXECUTION_MODE=container
# (and the tellus/transform-runtime:py38 image built from
# scripts/transform-runtime.Dockerfile). Proves:
#
#   (positive)   a normal transform runs in the container + SUCCEEDED;
#   (negative A) a transform reading a HOST-ONLY path FAILS (FileNotFoundError —
#                the path exists on the host but is absent in the container; if
#                isolation were broken the secret would be readable + the build
#                would SUCCEED);
#   (negative B) a transform opening a network socket FAILS under
#                --network=none.
#
# Portable: no dev-machine paths, no Keycloak — uses the CODE_REPOS_TEST_AUTH
# header bypass (same as scripts/verify-transforms-e2e.sh) and a host-only
# file this script itself places in /tmp (the container's /tmp is a tmpfs, so
# a host-side /tmp file is guaranteed absent inside). Exits non-zero on any
# assertion failure.
#
# Usage: TELLUS_BASE=http://localhost:3000 bash scripts/verify-transforms-sandbox.sh
# ============================================================================
set -uo pipefail

BASE="${TELLUS_BASE:-http://localhost:3000}/api/v1"
RUN=$(date +%s | tail -c 5)
FAILURES=0

AUTH=(-H "X-Tellus-Test-Principal: transforms-sandbox" -H "X-Tellus-Test-Roles: editor")
LAST_BUILD_RID=""
# Same fixed folder RID verify-transforms-e2e.sh uses (folders need Keycloak,
# which CI does not run).
FOLDER_RID="ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345"

# Host-only secret: container /tmp is a tmpfs, so this host-side file is
# invisible inside the sandbox — a read attempt must raise FileNotFoundError.
HOST_ONLY_FILE="/tmp/tellus-host-only-secret-$$"
printf 'HOST-ONLY-SECRET\n' > "$HOST_ONLY_FILE"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
ukey()  { uuidgen | tr '[:upper:]' '[:lower:]'; }

cleanup() { rm -f "$HOST_ONLY_FILE"; }
trap cleanup EXIT

setup_commit() {
  # $1 displayName  $2 transform file name  $3 python source
  local RID TIP RESP
  RESP=$(curl -s -X POST "$BASE/code-repositories" "${AUTH[@]}" \
    -H "Idempotency-Key: $(ukey)" -H 'Content-Type: application/json' \
    -d "{\"displayName\":\"$1\",\"parentFolderRid\":\"$FOLDER_RID\",\"templateId\":\"transforms-python\",\"templateVersion\":\"1.0.0\",\"defaultBranch\":\"master\"}")
  RID=$(echo "$RESP" | jq -r '.rid // empty')
  if [ -z "$RID" ] || [ "$RID" = "null" ]; then
    red "repo create failed: $RESP"; return 1
  fi
  sleep 2
  TIP=$(curl -s "$BASE/code-repositories/$RID/branches" "${AUTH[@]}" \
    | jq -r '.branches[] | select(.name == "master") | .headSha // empty' | head -1)
  curl -s -X POST "$BASE/code-repositories/$RID/branches/master/commits" "${AUTH[@]}" \
    -H "Idempotency-Key: $(ukey)" ${TIP:+-H "If-Match: \"$TIP\""} -H 'Content-Type: application/json' \
    -d "{\"message\":\"m\",\"fileChanges\":[{\"path\":\"transforms/$2\",\"op\":\"add\",\"contentBase64\":\"$(printf '%s' \"$3\" | base64 | tr -d '\n')\"}]}" \
    | jq -e '.commitSha // empty' >/dev/null || { red "commit failed for $1"; return 1; }
  echo "$RID"
}

build_poll() {
  # $1 repository rid -> "status|reason"
  local BUILD S BODY REASON i
  BODY=$(curl -s -X POST "$BASE/code-repositories/$1/builds" "${AUTH[@]}" \
    -H "Idempotency-Key: $(ukey)" -H 'Content-Type: application/json' \
    -d '{"branch":"master"}')
  BUILD=$(echo "$BODY" | jq -r '.buildRid // .rid // empty')
  if [ -z "$BUILD" ] || [ "$BUILD" = "null" ]; then
    red "build start failed for $1: $(echo "$BODY" | head -c 400)"
    echo "failed|build-not-started"; return
  fi
  S="running"; BODY=""
  for i in $(seq 1 90); do
    BODY=$(curl -s "$BASE/code-repositories/$1/builds/$BUILD" "${AUTH[@]}")
    S=$(echo "$BODY" | jq -r '.build.status // "unknown"')
    { [ "$S" = "succeeded" ] || [ "$S" = "failed" ]; } && break
    sleep 1
  done
  REASON=$(echo "$BODY" | jq -r '.build.reason // ""')
  LAST_BUILD_RID="$BUILD"
  echo "$S|$REASON"
}

dump_failure_events() {
  # $1 repository rid  $2 build rid — print the failing transform's stderr.
  # $2 is empty when the build never started; skip in that case (the POST
  # response was already printed by build_poll).
  [ -z "$2" ] && return 0
  curl -s "$BASE/code-repositories/$1/builds/$2" "${AUTH[@]}" | jq -r '
    .events[]? | select(.kind == "log" and .data.phase == "failed") |
    "[event] \(.data.transform): \(.data.error // "")\n" +
    (.data.stderr // "" | split("\n") | last(15) | join("\n"))' || true
}

# --- (positive) container build ---------------------------------------------
PY_OK=$(printf 'from transforms.api import transform, Output, DataFrame\n@transform(output=Output("ri.foundry.main.dataset.sandbox-ok-%s"))\ndef f(output):\n    output.write_dataframe(DataFrame([{"ok": 1, "sandboxed": True}]))\n' "$RUN")
RID_OK=$(setup_commit "sandbox-ok-$RUN" "t.py" "$PY_OK") || exit 1
green "=== (positive) container build ==="
RES_OK=$(build_poll "$RID_OK"); S_OK="${RES_OK%%|*}"; R_OK="${RES_OK#*|}"
[ "$S_OK" != "succeeded" ] && { red "--- failure events (positive) ---"; dump_failure_events "$RID_OK" "$LAST_BUILD_RID"; }
green "positive -> $S_OK | $R_OK"
curl -s -X DELETE "$BASE/code-repositories/$RID_OK" "${AUTH[@]}" >/dev/null 2>&1 || true

# --- (negative A) host-FS read blocked --------------------------------------
PY_FS=$(printf 'from transforms.api import transform, Output, DataFrame\n@transform(output=Output("ri.foundry.main.dataset.sandbox-fs-%s"))\ndef f(output):\n    data = open("%s").read()\n    output.write_dataframe(DataFrame([{"leaked": data[:20]}]))\n' "$RUN" "$HOST_ONLY_FILE")
RID_FS=$(setup_commit "sandbox-fs-$RUN" "t.py" "$PY_FS") || exit 1
green "=== (negative A) host-FS read blocked ==="
RES_FS=$(build_poll "$RID_FS"); S_FS="${RES_FS%%|*}"; R_FS="${RES_FS#*|}"
[ "$S_FS" != "failed" ] && { red "--- failure events (negative A) ---"; dump_failure_events "$RID_FS" "$LAST_BUILD_RID"; }
[ "$S_FS" = "failed" ] && ! echo "$R_FS" | grep -qiE "No such file or directory|FileNotFoundError|Errno 2" && { red "--- failure events (negative A, wrong reason) ---"; dump_failure_events "$RID_FS" "$LAST_BUILD_RID"; }
green "host-FS read -> $S_FS | $R_FS"
curl -s -X DELETE "$BASE/code-repositories/$RID_FS" "${AUTH[@]}" >/dev/null 2>&1 || true

# --- (negative B) network egress blocked ------------------------------------
PY_NET=$(printf 'from transforms.api import transform, Output, DataFrame\nimport urllib.request\n@transform(output=Output("ri.foundry.main.dataset.sandbox-net-%s"))\ndef f(output):\n    try:\n        urllib.request.urlopen("http://1.2.3.4", timeout=3).read()\n        output.write_dataframe(DataFrame([{"egress": "succeeded"}]))\n    except Exception as e:\n        raise RuntimeError("network egress unexpectedly available: " + repr(e))\n' "$RUN")
RID_NET=$(setup_commit "sandbox-net-$RUN" "t.py" "$PY_NET") || exit 1
green "=== (negative B) network egress blocked ==="
RES_NET=$(build_poll "$RID_NET"); S_NET="${RES_NET%%|*}"; R_NET="${RES_NET#*|}"
[ "$S_NET" != "failed" ] && { red "--- failure events (negative B) ---"; dump_failure_events "$RID_NET" "$LAST_BUILD_RID"; }
green "network egress -> $S_NET | $R_NET"
curl -s -X DELETE "$BASE/code-repositories/$RID_NET" "${AUTH[@]}" >/dev/null 2>&1 || true

echo ""
if [ "$S_OK" = "succeeded" ]; then
  green "PASS (positive): container build SUCCEEDED"
else
  red "FAIL (positive): $S_OK / $R_OK"; FAILURES=$((FAILURES + 1))
fi
if [ "$S_FS" = "failed" ] && echo "$R_FS" | grep -qiE "No such file or directory|FileNotFoundError|Errno 2"; then
  green "PASS (negative A): host-FS read BLOCKED (FileNotFoundError)"
else
  red "FAIL (negative A): $S_FS / $R_FS"; FAILURES=$((FAILURES + 1))
fi
if [ "$S_NET" = "failed" ]; then
  green "PASS (negative B): network egress BLOCKED"
else
  red "FAIL (negative B): $S_NET / $R_NET"; FAILURES=$((FAILURES + 1))
fi

[ "$FAILURES" -eq 0 ] && exit 0 || exit 1
