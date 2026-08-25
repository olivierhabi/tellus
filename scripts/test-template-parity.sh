#!/usr/bin/env bash
# ============================================================================
# scripts/test-template-parity.sh
#
# HTTP-level regression guard for the TR_PYTHON_2_0_0 (transforms-python@2.0.0)
# scaffold — pins Foundry "Project structure" parity so a future manifest
# edit cannot silently drift. Mirrors the ✅/➕/➖ comparison table from the
# parity audit (docs/foundry-parity/) so a failure is legible at a glance.
#
# Layer: this is the HTTP guard. The pure-logic guard lives at
#   tests/unit/code-repos/templates/transforms-python-2-parity-unit.test.ts
# and the E2E guard at
#   tellus-fe/cypress/e2e/transforms-python-template-parity.cy.ts.
#
# Reuses the existing API auth pattern (scripts/demo-code-repository-commit.sh):
# the backend runs with CODE_REPOS_TEST_AUTH=1 and this script sends
# X-Tellus-Test-Principal. No bespoke bootstrap — point TELLUS_BASE at a
# running tellus backend (the transforms-parity CI workflow stands one up).
#
# Usage:
#   TELLUS_BASE=http://localhost:3000 scripts/test-template-parity.sh
#
# Exits non-zero with a ✅/➕/➖ diff-style report on any mismatch.
# ============================================================================
set -euo pipefail

BASE="${TELLUS_BASE:-http://localhost:3000}"
PRINCIPAL="${TELLUS_PRINCIPAL:-cypress/parity}"
# A test repo RID + a test dataset RID (both conform to the rid regexes).
REPO_RID="ri.code-repos.main.repository.parity-0001-aaaa-bbbb-cccc-dddddddddd"
DATASET_RID="ri.foundry.main.dataset.parity-test-0001"
IDEM=0  # per-call idempotency-key counter (the middleware keys on the header alone)

# UUID v4 for the Idempotency-Key header (the middleware requires a UUID/ULID/
# 16-128 hex chars). Cross-platform: macOS uuidgen, Linux /proc, python fallback.
gen_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr 'A-Z' 'a-z'
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid
  else python3 -c "import uuid;print(uuid.uuid4())"
  fi
}

# Colors (disabled when not a tty so CI logs stay clean).
if [[ -t 1 ]]; then
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; CYAN=""; RESET=""
fi

PASS=0
FAIL=0
report_pass() { printf "  ${GREEN}✅ Match${RESET}  %s\n" "$1"; PASS=$((PASS+1)); }
report_extra() { printf "  ${YELLOW}➕ Extra${RESET}  %s  (not in target tree)\n" "$1"; FAIL=$((FAIL+1)); }
report_missing() { printf "  ${RED}➖ Missing${RESET}  %s  (in target tree, not scaffolded)\n" "$1"; FAIL=$((FAIL+1)); }
report_bad_content() { printf "  ${RED}⚠ Bad content${RESET}  %s — %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
fail() { printf "${RED}FAIL${RESET}: %s\n" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v jq   >/dev/null 2>&1 || fail "jq is required"

# Curl wrapper — sends the test principal header, captures body + status.
api() {
  local method="$1" path="$2" body="${3:-}"
  local code
  code=$(curl -sS -X "$method" \
    -H "Content-Type: application/json" \
    -H "X-Tellus-Test-Principal: $PRINCIPAL" \
    -H "Idempotency-Key: $(gen_uuid)" \
    ${body:+-d "$body"} \
    -o /tmp/_parity_body.json -w "%{http_code}" \
    "${BASE}${path}" 2>/dev/null) || code="000"
  echo "$code"
}

# --- Stand up a scaffold via the admin scaffold route (POST /api/v1/scaffold).
# This route is API-only (internal saga endpoint); the user-facing UI is the
# code-repositories/new wizard which triggers the saga via POST /api/v1/code-repositories.
echo "[parity] POST /api/v1/scaffold  transforms-python@2.0.0  (packageName=palantir, datasetRid=$DATASET_RID)"
CODE=$(api POST /api/v1/scaffold "{\"templateId\":\"transforms-python\",\"version\":\"2.0.0\",\"repositoryRid\":\"$REPO_RID\",\"repoDisplayName\":\"Parity Test\",\"parameters\":{\"packageName\":\"palantir\",\"datasetRid\":\"$DATASET_RID\"}}")
[[ "$CODE" == "201" ]] || fail "scaffold failed: HTTP $CODE — body: $(cat /tmp/_parity_body.json)"

# --- File-path set comparison (✅ / ➕ / ➖).
# The 11 paths 2.0.0 must ship (6 Foundry-confirmed + 3 tellus tooling + 2 tellus platform files
# kept per DECISIONS.md §1). Unconfirmed-content files are OMITTED by design
# (§3) — their absence is NOT a failure.
EXPECTED_PATHS=(
  "src/palantir/__init__.py"
  "src/palantir/pipeline.py"
  "src/palantir/datasets/__init__.py"
  "src/palantir/datasets/examples.py"
  "src/setup.py"
  "src/setup.cfg"
  "conda_recipe/meta.yaml"
  "requirements.lock"
  "ci.yml"
  "Makefile"
  "repoSettings.json"
)
# Paths that must NOT appear (omitted unconfirmed files + removed 1.0.0 extras).
FORBIDDEN_PATHS=(
  "build.gradle" "gradle.properties" "versions.properties"
  "templateConfig.json" "conda-versions.run.linux-64.lock" "src/.pylintrc"
  "transforms/example.py" "transforms/enrich.py" "transforms/_incremental_example.py"
)

ACTUAL_PATHS=()
while IFS= read -r line; do [[ -n "$line" ]] && ACTUAL_PATHS+=("$line"); done < <(jq -r '.files[].path' /tmp/_parity_body.json)

contains() { local needle="$1"; case " ${ACTUAL_PATHS[*]} " in *" $needle "*) return 0;; esac; return 1; }

echo "[parity] file-path set:"
for p in "${EXPECTED_PATHS[@]}"; do
  if contains "$p"; then report_pass "$p"; else report_missing "$p"; fi
done
for p in "${ACTUAL_PATHS[@]}"; do
  found=0
  for e in "${EXPECTED_PATHS[@]}"; do [[ "$e" == "$p" ]] && { found=1; break; }; done
  [[ $found -eq 0 ]] && report_extra "$p"
done
for p in "${FORBIDDEN_PATHS[@]}"; do
  if contains "$p"; then report_extra "$p (forbidden — omitted by design per DECISIONS.md §3/§1)"; fi
done

# --- Content invariants (grep key strings in the scaffolded file contents).
content_of() { jq -r --arg p "$1" '.files[] | select(.path==$p) | .content' /tmp/_parity_body.json; }

echo "[parity] content invariants:"
check() { local path="$1" needle="$2" label="$3"; local c; c="$(content_of "$path")"; if grep -qF "$needle" <<<"$c"; then report_pass "$label"; else report_bad_content "$path" "missing: $needle"; fi; }

check "src/palantir/pipeline.py" "from palantir import datasets"        "pipeline.py: from palantir import datasets"
check "src/palantir/pipeline.py" "my_pipeline.discover_transforms(datasets)" "pipeline.py: discover_transforms(datasets)"
check "src/palantir/pipeline.py" "my_pipeline = Pipeline()"            "pipeline.py: Pipeline() instance"
check "src/setup.py"             "'transforms.pipelines'"              "setup.py: transforms.pipelines entry point"
check "src/setup.py"             "'root = palantir.pipeline:my_pipeline'" "setup.py: root = palantir.pipeline:my_pipeline"
check "src/setup.py"             "find_packages(exclude=['contrib', 'docs', 'test'])" "setup.py: find_packages(exclude=[...])"
check "conda_recipe/meta.yaml"   "python 3.9.*"                        "meta.yaml: python 3.9.* pin"
check "conda_recipe/meta.yaml"   "transforms {{ PYTHON_TRANSFORMS_VERSION }}" "meta.yaml: transforms run dep"
check "conda_recipe/meta.yaml"   "transforms-expectations"             "meta.yaml: transforms-expectations run dep"
check "conda_recipe/meta.yaml"   "python setup.py install --single-version-externally-managed --record=record.txt" "meta.yaml: build script"
check "src/palantir/datasets/examples.py" "# @transform.using("        "examples.py: commented-out starter"
check "src/palantir/datasets/examples.py" "output_dataset.write_table(input_dataset.polars(lazy=True))" "examples.py: Polars compute engine"
check "ci.yml"                   "python -m pyflakes src/"             "ci.yml: lints src/ (not transforms/)"
check "repoSettings.json"        "jemma:build"                         "repoSettings.json: jemma:build status check"

# Foundry build-time tokens must survive literal (tellus must not resolve them).
check "src/setup.py"             "author='{{ REPOSITORY_ORG_NAME }}'"  "setup.py: {{ REPOSITORY_ORG_NAME }} left literal (spaced)"
check "conda_recipe/meta.yaml"   'name: "{{ PACKAGE_NAME }}"'         "meta.yaml: {{ PACKAGE_NAME }} left literal"

# datasetRid substitution into the commented example paths.
check "src/palantir/datasets/examples.py" "Output(\"$DATASET_RID\")"  "examples.py: datasetRid substituted into output path"
check "src/palantir/datasets/examples.py" "Input(\"$DATASET_RID\")"   "examples.py: datasetRid substituted into input path"

# No unsubstituted tellus tokens may leak.
leak=$(jq -r '.files[].content' /tmp/_parity_body.json | grep -c '{{packageName}}\|{{datasetRid}}' || true)
if [[ "$leak" -gt 0 ]]; then report_bad_content "(any)" "$leak unsubstituted {{packageName}}/{{datasetRid}} token(s) leaked"; else report_pass "no {{packageName}}/{{datasetRid}} token leaks"; fi

# --- Spec 2: default datasetRid substitution (scaffold with NO parameters → defaults).
echo "[parity] default-parameter scaffold (datasetRid → ri.foundry.main.dataset.placeholder):"
CODE2=$(api POST /api/v1/scaffold "{\"templateId\":\"transforms-python\",\"version\":\"2.0.0\",\"repositoryRid\":\"$REPO_RID-default\",\"repoDisplayName\":\"Parity Default\",\"parameters\":{}}")
[[ "$CODE2" == "201" ]] || fail "default scaffold failed: HTTP $CODE2 — body: $(cat /tmp/_parity_body.json)"
DEFAULT_EXAMPLES=$(jq -r '.files[] | select(.path=="src/palantir/datasets/examples.py") | .content' /tmp/_parity_body.json)
if grep -qF 'Output("ri.foundry.main.dataset.placeholder")' <<<"$DEFAULT_EXAMPLES" && \
   grep -qF 'Input("ri.foundry.main.dataset.placeholder")'  <<<"$DEFAULT_EXAMPLES"; then
  report_pass "default datasetRid (ri.foundry.main.dataset.placeholder) lands in examples.py"
else
  report_bad_content "examples.py" "default datasetRid not substituted"
fi
# Default packageName (palantir) lands in pipeline.py + setup.py entry point.
DEFAULT_PIPE=$(jq -r '.files[] | select(.path=="src/palantir/pipeline.py") | .content' /tmp/_parity_body.json)
if grep -qF "from palantir import datasets" <<<"$DEFAULT_PIPE"; then report_pass "default packageName (palantir) lands in pipeline.py"; else report_bad_content "pipeline.py" "default packageName not applied"; fi

# --- Verdict.
echo
if [[ "$FAIL" -eq 0 ]]; then
  printf "${GREEN}PARITY OK${RESET}: %d checks passed, 0 failures.\n" "$PASS"
  exit 0
else
  printf "${RED}PARITY DRIFT${RESET}: %d passed, ${RED}%d failed${RESET}.\n" "$PASS" "$FAIL"
  exit 1
fi
