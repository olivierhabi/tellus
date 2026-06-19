#!/usr/bin/env bash
# scripts/verify-handoff.sh — re-derive sha256 + line counts of every artifact
# listed in tasks/quiver/HANDOFF_INDEX.md and diff against the disk.
# Exit non-zero on any mismatch. Called from quiver-verify.sh stage 7.
#
# HANDOFF_INDEX.md format (the leading "| ----- |" header rows are skipped):
#   | path | sha256 | lines | purpose |
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INDEX="tasks/quiver/HANDOFF_INDEX.md"
if [ ! -f "$INDEX" ]; then
  echo "[handoff] $INDEX missing"
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  HASHFN() { sha256sum "$1" | awk '{print $1}'; }
else
  HASHFN() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

errors=0
checked=0
# Parse the index via awk: trim whitespace from each pipe-separated cell and
# emit tab-separated (path, sha, lines) triples for rows whose sha column is
# a 64-char hex string. This rejects header / divider / placeholder rows
# without bash-version-dependent globbing.
parse_index() {
  awk -F'|' '
    {
      if (NF < 5) next
      path=$2; sha=$3; lines=$4
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", path)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", sha)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", lines)
      if (length(sha) != 64) next
      if (sha !~ /^[0-9a-f]+$/) next
      print path "\t" sha "\t" lines
    }
  ' "$INDEX"
}

while IFS=$'\t' read -r path expected_hash expected_lines; do
  if [ ! -f "$path" ]; then
    echo "[handoff] $path: missing on disk"
    errors=$((errors+1))
    continue
  fi
  actual_hash="$(HASHFN "$path")"
  actual_lines="$(wc -l < "$path" | tr -d ' ')"
  if [ "$actual_hash" != "$expected_hash" ]; then
    echo "[handoff] $path: sha mismatch — expected $expected_hash, got $actual_hash"
    errors=$((errors+1))
  fi
  if [ "$actual_lines" != "$expected_lines" ]; then
    echo "[handoff] $path: line-count mismatch — expected $expected_lines, got $actual_lines"
    errors=$((errors+1))
  fi
  checked=$((checked+1))
done < <(parse_index)

if [ "$checked" -lt 1 ]; then
  echo "[handoff] no rows in HANDOFF_INDEX — invalid"
  exit 1
fi

if [ "$errors" -ne 0 ]; then
  echo "[handoff] $errors mismatch(es) over $checked rows"
  exit 1
fi

echo "[handoff] OK — $checked artifacts verified against HANDOFF_INDEX.md"
exit 0
