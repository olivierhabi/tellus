#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# A — verify-all.sh exists and is executable.
test -x scripts/verify-all.sh || { echo "verify-all.sh missing/not executable" >&2; exit 1; }

# B — SUBTASKS counts.  The DoD check is "0 ⏳" rows; FINAL.07 itself is
# IN_PROGRESS at this point and will flip to ✅ only after this gate exits 0.
PENDING=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md | grep -c '⏳')
DONE=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md | grep -c '✅')
INPROG=$(grep -E '^\| (B[0-9]|F[0-9]|FINAL)' tasks/files-projects/SUBTASKS.md | grep -c 'IN_PROGRESS')
echo "DoD: ✅=${DONE} ⏳=${PENDING} IN_PROGRESS=${INPROG}"
if [[ "${PENDING// /}" != "0" ]]; then
  echo "Pending rows remain — DoD not met" >&2
  exit 1
fi
# Allow exactly one IN_PROGRESS row (FINAL.07 itself).
if [[ "${INPROG// /}" -gt 1 ]]; then
  echo "More than one IN_PROGRESS row — DoD not met" >&2
  exit 1
fi
echo "FINAL.07 GREEN"
exit 0
