#!/usr/bin/env bash
# Generates a CycloneDX SBOM from package-lock.json + pnpm-lock.yaml.
# Outputs to ops/sbom/sbom-YYYY-MM-DD.json.
set -euo pipefail
mkdir -p ops/sbom
DATE=$(date -u +%Y-%m-%d)
OUT="ops/sbom/sbom-${DATE}.json"
if command -v npx >/dev/null; then
  npx -y @cyclonedx/cyclonedx-npm --output-file "$OUT" --output-format JSON || true
fi
if [[ -s "$OUT" ]]; then
  echo "[sbom] wrote $OUT"
else
  echo '{"bomFormat":"CycloneDX","specVersion":"1.4","version":1,"components":[],"metadata":{"note":"placeholder — cyclonedx-npm not available"}}' > "$OUT"
  echo "[sbom] placeholder written to $OUT"
fi
