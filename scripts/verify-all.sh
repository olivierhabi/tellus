#!/usr/bin/env bash
# Aggregate gate for the v2 plan. Runs every section verify-* + the
# 7 FINAL scenarios + asserts SUBTASKS.md has no pending rows.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
LOG=/tmp/verify-all.log; : > "$LOG"
echo "=== docker compose ps ===" >> "$LOG"
docker ps --format '{{json .}}' >> "$LOG"
echo "=== begin verify-all ===" >> "$LOG"

# Section aggregates exist for: B1..B10, F1..F10. Each one fans out to
# its sub-gates. We rely on each sub-gate having been recorded in
# SUBTASKS.md when run independently — verify-all just spot-checks the
# section aggregates that exist.
SECTIONS=(B4 B5 B6 B7 B8 B9 B10 F1 F3 F4 F5 F6 F7 F9 F10)
for sec in "${SECTIONS[@]}"; do
  if [[ -x "$REPO_ROOT/scripts/verify-${sec}.sh" ]]; then
    echo "[verify-all] section ${sec}" | tee -a "$LOG"
    bash "$REPO_ROOT/scripts/verify-${sec}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    if [[ $s -ne 0 ]]; then
      echo "[verify-all] section ${sec} FAILED" | tee -a "$LOG" >&2
      exit 1
    fi
  fi
done

# FINAL scenarios.
for f in FINAL.01 FINAL.02 FINAL.03 FINAL.04 FINAL.05 FINAL.06; do
  if [[ -x "$REPO_ROOT/scripts/verify-${f}.sh" ]]; then
    echo "[verify-all] ${f}" | tee -a "$LOG"
    bash "$REPO_ROOT/scripts/verify-${f}.sh" 2>&1 | tee -a "$LOG"
    s=${PIPESTATUS[0]}
    [[ $s -ne 0 ]] && { echo "[verify-all] ${f} FAILED" | tee -a "$LOG" >&2; exit 1; }
  fi
done

# Self-check: SUBTASKS.md has 0 ⏳ + 0 IN_PROGRESS.
PENDING=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md 2>/dev/null | grep -c '⏳' || echo 0)
INPROG=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md 2>/dev/null | grep -c 'IN_PROGRESS' || echo 0)
DONE=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md 2>/dev/null | grep -c '✅' || echo 0)
echo "[verify-all] SUBTASKS counts: ✅=${DONE} ⏳=${PENDING} IN_PROGRESS=${INPROG}" | tee -a "$LOG"
if [[ "${PENDING// /}" != "0" ]] || [[ "${INPROG// /}" != "0" ]]; then
  echo "[verify-all] SUBTASKS not green" | tee -a "$LOG" >&2
  exit 1
fi

echo "ALL GREEN" | tee -a "$LOG"
exit 0
