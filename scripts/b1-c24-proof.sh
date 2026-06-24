#!/usr/bin/env bash
# B1.bf2 — green/red/green wiring-proof harness for the B1-C-24 contract
# (resources row materialised in the *same* transaction as the legacy
# project / folder insert).
#
# Phases:
#   1. GREEN  — run scripts/b1-c24-proof.ts as shipped; expect exit 0 and
#               the literal `[GREEN]` marker. Tee to /tmp/b1-c24-green.log
#               with a `PASS` token appended on success.
#   2. RED    — disable the same-txn INSERT INTO resources in
#               projectService.ts by retargeting it to a non-existent
#               table; rerun the proof; expect non-zero and a `FAIL`
#               token in /tmp/b1-c24-red.log.
#   3. GREEN2 — restore the wiring; rerun; expect exit 0 and `PASS` in
#               /tmp/b1-c24-green2.log.
#
# The B1.bf2 Exit Gate is the literal v2 stanza:
#
#   test -s /tmp/b1-c24-green.log && \
#     test -s /tmp/b1-c24-red.log && \
#     test -s /tmp/b1-c24-green2.log && \
#     grep -q 'PASS' /tmp/b1-c24-green.log && \
#     grep -q 'FAIL\|✗\|❌' /tmp/b1-c24-red.log && \
#     grep -q 'PASS' /tmp/b1-c24-green2.log && \
#     echo "B1.bf2 GREEN"

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_SVC="src/services/projectService.ts"
BACKUP="$(mktemp /tmp/b1-c24-projectService.bak.XXXXXX)"

restore() {
  if [[ -s "$BACKUP" ]]; then
    cp "$BACKUP" "$PROJECT_SVC"
    echo "[restore] $PROJECT_SVC restored from $BACKUP"
  fi
}
trap restore EXIT

# ---- Phase 1: GREEN ---------------------------------------------------------
: > /tmp/b1-c24-green.log
echo "=== Phase 1: GREEN (wiring intact) ===" | tee -a /tmp/b1-c24-green.log
npx tsx scripts/b1-c24-proof.ts 2>&1 | tee -a /tmp/b1-c24-green.log
phase1=${PIPESTATUS[0]}
if [[ $phase1 -eq 0 ]] && grep -q '\[GREEN\]' /tmp/b1-c24-green.log; then
  echo "PASS — phase 1 (intact wiring) exit 0 with [GREEN] marker" \
    | tee -a /tmp/b1-c24-green.log
else
  echo "FAIL — phase 1 expected exit 0 + [GREEN]; got exit $phase1" \
    | tee -a /tmp/b1-c24-green.log
  exit 1
fi

# ---- Phase 2: RED -----------------------------------------------------------
cp "$PROJECT_SVC" "$BACKUP"
# Disable the same-txn resources insert by retargeting the SQL to a
# table that does not exist; the proof must then fail at the resources
# lookup (or at the SQL execution itself).
sed -i.bak 's/INSERT INTO resources (/INSERT INTO resources_DISABLED_BY_B1BF2_PROOF (/' "$PROJECT_SVC"
rm -f "$PROJECT_SVC.bak"
if ! diff -q "$BACKUP" "$PROJECT_SVC" > /dev/null; then
  echo "[red-setup] retargeted INSERT INTO resources → resources_DISABLED_BY_B1BF2_PROOF in $PROJECT_SVC"
else
  echo "FAIL — sed did not modify $PROJECT_SVC" >&2
  exit 1
fi

: > /tmp/b1-c24-red.log
echo "=== Phase 2: RED (wiring stashed) ===" | tee -a /tmp/b1-c24-red.log
npx tsx scripts/b1-c24-proof.ts 2>&1 | tee -a /tmp/b1-c24-red.log
phase2=${PIPESTATUS[0]}
if [[ $phase2 -ne 0 ]] && grep -qE '\[RED\]|relation .* does not exist|FAIL B1-C-24' /tmp/b1-c24-red.log; then
  echo "FAIL — phase 2 (stashed wiring) exit $phase2 with [RED] marker (expected)" \
    | tee -a /tmp/b1-c24-red.log
else
  echo "FAIL — phase 2 expected non-zero exit; got $phase2" \
    | tee -a /tmp/b1-c24-red.log
  exit 1
fi

# ---- Phase 3: GREEN2 --------------------------------------------------------
cp "$BACKUP" "$PROJECT_SVC"
echo "[restore] phase 3: $PROJECT_SVC restored from backup"

: > /tmp/b1-c24-green2.log
echo "=== Phase 3: GREEN2 (wiring restored) ===" | tee -a /tmp/b1-c24-green2.log
npx tsx scripts/b1-c24-proof.ts 2>&1 | tee -a /tmp/b1-c24-green2.log
phase3=${PIPESTATUS[0]}
if [[ $phase3 -eq 0 ]] && grep -q '\[GREEN\]' /tmp/b1-c24-green2.log; then
  echo "PASS — phase 3 (restored wiring) exit 0 with [GREEN] marker" \
    | tee -a /tmp/b1-c24-green2.log
else
  echo "FAIL — phase 3 expected exit 0 + [GREEN]; got exit $phase3" \
    | tee -a /tmp/b1-c24-green2.log
  exit 1
fi

echo "[b1-c24-proof.sh] all three phases asserted"
exit 0
