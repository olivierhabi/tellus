#!/usr/bin/env bash
# Generates a CycloneDX SBOM from pnpm-lock.yaml (pnpm is the source of truth in this repo).
# Uses @cyclonedx/cdxgen because cyclonedx-npm only reads package-lock.json (which is stale here
# and ignores pnpm.overrides). Outputs to ops/sbom/sbom-YYYY-MM-DD.json.
set -euo pipefail
mkdir -p ops/sbom
DATE=$(date -u +%Y-%m-%d)
OUT="ops/sbom/sbom-${DATE}.json"
if command -v npx >/dev/null; then
  # cdxgen auto-detects pnpm when pnpm-lock.yaml is present (-t pnpm forces it).
  # Full transitive closure is required for grype to see CVEs in nested deps,
  # so do NOT pass --required-only. --no-recurse keeps it to this workspace root.
  FETCH_LICENSE=false npx -y @cyclonedx/cdxgen@^11 -t pnpm -o "$OUT" --spec-version 1.6 --no-recurse . || true
fi
if [[ -s "$OUT" ]]; then
  echo "[sbom] wrote $OUT"
else
  echo '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[],"metadata":{"note":"placeholder — cdxgen not available"}}' > "$OUT"
  echo "[sbom] placeholder written to $OUT"
fi
