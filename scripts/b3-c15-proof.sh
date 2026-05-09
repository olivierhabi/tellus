#!/usr/bin/env bash
# B3.bf3 — green/red/green wiring-proof harness for B3-C-15 (If-Match
# guard wired into the v2 PUT handler).  Mirrors scripts/b1-c24-proof.sh.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GUARD="src/middleware/ifMatchV2.ts"
BACKUP="$(mktemp /tmp/b3-c15-ifMatchV2.bak.XXXXXX)"

restore() {
  if [[ -s "$BACKUP" ]]; then
    cp "$BACKUP" "$GUARD"
    echo "[restore] $GUARD restored"
  fi
}
trap restore EXIT

# Phase 1: GREEN
: > /tmp/b3-c15-green.log
echo "=== Phase 1: GREEN (guard intact) ===" | tee -a /tmp/b3-c15-green.log
npx tsx scripts/b3-c15-proof.ts 2>&1 | tee -a /tmp/b3-c15-green.log
p1=${PIPESTATUS[0]}
if [[ $p1 -eq 0 ]] && grep -q '\[GREEN\]' /tmp/b3-c15-green.log; then
  echo "PASS — phase 1 exit 0 with [GREEN]" | tee -a /tmp/b3-c15-green.log
else
  echo "FAIL — phase 1 exit $p1" | tee -a /tmp/b3-c15-green.log
  exit 1
fi

# Phase 2: RED — stash the guard body to a no-op return.
cp "$GUARD" "$BACKUP"
python3 - "$GUARD" <<'PY'
import sys, re
p=sys.argv[1]
s=open(p).read()
# Replace the body of requireIfMatchV2 with a no-op return.
s2 = re.sub(
  r'(export function requireIfMatchV2\([\s\S]*?\)\s*:\s*void\s*\{)[\s\S]*?(\n\})',
  r'\1\n  // STASHED_BY_B3BF3_PROOF\n  return;\n\2',
  s,
  count=1,
)
if s == s2:
  sys.stderr.write("ERROR: regex did not match requireIfMatchV2 body\n")
  sys.exit(2)
open(p,'w').write(s2)
PY
if diff -q "$BACKUP" "$GUARD" >/dev/null; then
  echo "FAIL — stash did not modify $GUARD" >&2
  exit 1
fi
echo "[red-setup] requireIfMatchV2 body stashed to no-op return"

: > /tmp/b3-c15-red.log
echo "=== Phase 2: RED (guard stashed) ===" | tee -a /tmp/b3-c15-red.log
npx tsx scripts/b3-c15-proof.ts 2>&1 | tee -a /tmp/b3-c15-red.log
p2=${PIPESTATUS[0]}
if [[ $p2 -ne 0 ]] && grep -qE '\[RED\]|FAIL B3-C-15' /tmp/b3-c15-red.log; then
  echo "FAIL — phase 2 (stashed) exit $p2 with [RED] (expected)" | tee -a /tmp/b3-c15-red.log
else
  echo "FAIL — phase 2 expected non-zero; got $p2" | tee -a /tmp/b3-c15-red.log
  exit 1
fi

# Phase 3: GREEN2 — restore.
cp "$BACKUP" "$GUARD"
echo "[restore] phase 3: $GUARD restored"
: > /tmp/b3-c15-green2.log
echo "=== Phase 3: GREEN2 (guard restored) ===" | tee -a /tmp/b3-c15-green2.log
npx tsx scripts/b3-c15-proof.ts 2>&1 | tee -a /tmp/b3-c15-green2.log
p3=${PIPESTATUS[0]}
if [[ $p3 -eq 0 ]] && grep -q '\[GREEN\]' /tmp/b3-c15-green2.log; then
  echo "PASS — phase 3 exit 0 with [GREEN]" | tee -a /tmp/b3-c15-green2.log
else
  echo "FAIL — phase 3 exit $p3" | tee -a /tmp/b3-c15-green2.log
  exit 1
fi

exit 0
