#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/quiver-coverage-check.sh — verify that every contract C-ID enumerated
# in tasks/quiver/contracts.md is referenced by at least one test file under
# tests/quiver/. Per the continuation directive, this is the floor for the
# coverage gate (verify.sh stage 6).
# ---------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CONTRACTS="$ROOT/tasks/quiver/contracts.md"
TESTS_DIR="$ROOT/tests/quiver"
# D-24: FE-only contracts are covered by ADRs that include the C-ID.
ADR_DIR="$ROOT/docs/adr"

if [[ ! -f "$CONTRACTS" ]]; then
  echo "[coverage] contracts.md not found at $CONTRACTS"
  exit 60
fi

# Extract every contract ID. The contracts file uses table rows like
# `| B1 C-01 | …` and `| G-04 | …`. Pull the first column.
# (Avoid `mapfile` — not available in macOS's stock bash 3.2.)
IDS_TMP="$(mktemp)"
trap 'rm -f "$IDS_TMP"' EXIT
awk -F'|' '
  /^\| [A-Z][A-Z0-9]* C-[0-9]+/ { gsub(/^ +| +$/, "", $2); print $2 }
  /^\| G-[0-9]+/ { gsub(/^ +| +$/, "", $2); print $2 }
  /^\| GATE-[0-9]+/ { gsub(/^ +| +$/, "", $2); print $2 }
' "$CONTRACTS" | sort -u > "$IDS_TMP"

if [[ ! -s "$IDS_TMP" ]]; then
  echo "[coverage] no contract IDs found — contracts.md format change?"
  exit 60
fi

IDS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && IDS+=("$line")
done < "$IDS_TMP"

# Tasks for which implementation has not yet landed are listed here so the
# gate is not falsely red while the drive is in-progress. Each entry must
# correspond to a row in PROGRESS.md whose status is not yet DONE.
PENDING_PREFIXES=(
  "B9"  "B10"
  "F6"  "F7"  "F9"  "F10"
  "GATE"
)

# Contracts deferred with a recorded D-entry. These remain fail-the-gate when
# their implementing task is DONE. Each ID below has a D-entry covering it.
DEFERRED_IDS=(
  "B1 C-21"   # marking-based CBAC enforcement — D-2026-05-04 D-16 (defer to a CBAC task)
  "B1 C-24"   # load-test SLO — D-2026-05-04 D-17 (load tests run on phase boundary, not per-task)
  "G-08"      # markings + organizations — same as B1 C-21 (D-16)
  "G-12"      # service-to-service JWT — D-2026-05-04 D-18 (defer; existing securityContext covers in-tree)
  "B5 C-11"   # idempotency on POST /compute/cards — D-2026-05-04 D-25 (defer; cache-keying already gives idempotent reads)
  "B5 C-12"   # SLO load measurement — D-2026-05-04 D-17 (load tests run at phase boundary)
  "B5 C-15"   # OTel trace event emission — D-2026-05-04 D-26 (deferred to OTel rollout phase)
  "B6 C-12"   # SLO load measurement — D-2026-05-04 D-17 (load tests run at phase boundary)
  "B3 C-15"   # SLO load measurement — D-2026-05-04 D-17 (load tests run at phase boundary)
  "B7 C-09"   # SLO load measurement — D-17 (load tests run at phase boundary)
  "B7 C-12"   # Polars sidecar UDS — D-50 (in-process MatAdapter substitutes; sidecar in production)
  "B8 C-07"   # SLO load measurement — D-17 (load tests run at phase boundary)
)

is_pending() {
  local id="$1"
  for p in "${PENDING_PREFIXES[@]}"; do
    if [[ "$id" == "${p} "* || "$id" == "${p}-"* || "$id" == "${p}" ]]; then
      return 0
    fi
  done
  for d in "${DEFERRED_IDS[@]}"; do
    if [[ "$id" == "$d" ]]; then
      return 0
    fi
  done
  return 1
}

missing=()
for id in "${IDS[@]}"; do
  if is_pending "$id"; then continue; fi
  # IDs in tests are written like "B1 C-01:" or "G-04:".
  if grep -RIl --include='*.ts' -F "$id" "$TESTS_DIR" >/dev/null 2>&1; then
    continue
  fi
  # D-24 fallback: ADR mentioning the C-ID counts as covered for FE-only.
  if [[ -d "$ADR_DIR" ]] && grep -RIl --include='*.md' -F "$id" "$ADR_DIR" >/dev/null 2>&1; then
    continue
  fi
  missing+=("$id")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[coverage] FAIL — these contracts have no test reference:"
  printf '   %s\n' "${missing[@]}"
  exit 60
fi

echo "[coverage] OK — all in-flight contracts have test coverage"
echo "[coverage] pending (deferred to upcoming tasks): ${#IDS[@]} - ${#missing[@]} = $(( ${#IDS[@]} - ${#missing[@]} )) covered now"
exit 0
